// eslint-disable-next-line import/no-extraneous-dependencies -- diff is a web dependency
import { merge as mergeText } from 'diff'
import ProjectDetailsHandler from '../../../../app/src/Features/Project/ProjectDetailsHandler.mjs'
import ProjectDuplicator from '../../../../app/src/Features/Project/ProjectDuplicator.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import TagsHandler from '../../../../app/src/Features/Tags/TagsHandler.mjs'
import { SyncBranch } from './models/SyncBranch.mjs'
import ProjectRef from './ProjectRef.mjs'
import SnapshotService from './SnapshotService.mjs'
import VersionService from './VersionService.mjs'
import WriteService from './WriteService.mjs'
import { BranchNotFoundError } from './Errors.mjs'

const SUFFIX = name => ` [branch: ${name}]`

function idOf(value) {
  return String(value?._id ?? value)
}

function fileEqual(left, right) {
  if (!left && !right) return true
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === 'doc') return left.content === right.content
  return left.hash === right.hash
}

function classify(base, branch, parent) {
  const branchChanged = !fileEqual(branch, base)
  const parentChanged = !fileEqual(parent, base)
  if (!branchChanged && !parentChanged) return 'unchanged'
  if (branchChanged && !parentChanged) return 'branch_only'
  if (!branchChanged && parentChanged) return 'parent_only'
  if (fileEqual(branch, parent)) return 'both_same'
  return 'both_differ'
}

function snapshotMap(snapshot) {
  return new Map((snapshot?.files || []).map(file => [file.path, file]))
}

function mergedContent(result, baseContent) {
  const baseLines = String(baseContent ?? '').split('\n')
  const output = []
  let cursor = 0
  for (const hunk of result.hunks || []) {
    const start = Math.max(0, (hunk.oldStart || 1) - 1)
    output.push(...baseLines.slice(cursor, start))
    for (const line of hunk.lines || []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('-')) continue
      if (line.startsWith('+') || line.startsWith(' '))
        output.push(line.slice(1))
      else output.push(line)
    }
    cursor = start + (hunk.oldLines || 0)
  }
  output.push(...baseLines.slice(cursor))
  return output.join('\n')
}

async function getBranch(branchProjectId) {
  const record = await SyncBranch.findOne({ branchProjectId })
  if (!record) throw new BranchNotFoundError()
  return record
}

async function createBranch(parentProjectId, userId, { name }) {
  await ProjectRef.requireAccess(userId, parentProjectId, 'read')
  const parent = await ProjectGetter.promises.getProject(parentProjectId, {
    name: true,
  })
  const latest = await VersionService.getLatestVersion(parentProjectId)
  const branchName = String(name ?? '')
  const suffix = SUFFIX(branchName)
  const baseName = String(parent?.name || '').slice(
    0,
    Math.max(0, 150 - suffix.length)
  )
  const projectName = ProjectDetailsHandler.fixProjectName(baseName + suffix)
  const project = await ProjectDuplicator.promises.duplicate(
    { _id: userId },
    parentProjectId,
    projectName,
    [],
    { isDebugCopy: false, cloneHistory: false, cloneRanges: false }
  )
  await TagsHandler.promises.addProjectToTagName(
    userId,
    `branch: ${String(parent?.name || '').slice(0, 40)}`,
    project._id
  )
  const record = await SyncBranch.create({
    branchProjectId: project._id,
    parentProjectId,
    baseVersion: latest.version,
    name: branchName,
    createdBy: userId,
    status: 'open',
    mergedVersion: null,
    mergedAt: null,
  })
  return {
    branch_project_id: idOf(project),
    url: ProjectRef.urlFor(idOf(project)),
    name: record.name,
    base_version: record.baseVersion,
    parent_project_id: idOf(parentProjectId),
  }
}

async function listBranches(parentProjectId, userId) {
  await ProjectRef.requireAccess(userId, parentProjectId, 'read')
  const records = await SyncBranch.find({
    parentProjectId,
    status: { $in: ['open', 'merged'] },
  })
  const branches = []
  for (const record of records || []) {
    const latest = await VersionService.getLatestVersion(record.branchProjectId)
    branches.push({
      branch_project_id: idOf(record.branchProjectId),
      parent_project_id: idOf(record.parentProjectId),
      url: ProjectRef.urlFor(idOf(record.branchProjectId)),
      name: record.name,
      base_version: record.baseVersion,
      branch_version: latest.version,
      status: record.status,
      merged_version: record.mergedVersion ?? null,
      merged_at: record.mergedAt ?? null,
    })
  }
  return { branches, count: branches.length }
}

async function diffBranch(branchProjectId, userId) {
  const branch = await getBranch(branchProjectId)
  await ProjectRef.requireAccess(userId, branch.parentProjectId, 'read')
  await ProjectRef.requireAccess(userId, branch.branchProjectId, 'read')
  const [branchVersion, parentVersion] = await Promise.all([
    VersionService.getLatestVersion(branch.branchProjectId),
    VersionService.getLatestVersion(branch.parentProjectId),
  ])
  const [base, ours, theirs] = await Promise.all([
    SnapshotService.getSnapshot(branch.parentProjectId, branch.baseVersion, {
      includeBinary: true,
    }),
    SnapshotService.getSnapshot(branch.branchProjectId, branchVersion.version, {
      includeBinary: true,
    }),
    SnapshotService.getSnapshot(branch.parentProjectId, parentVersion.version, {
      includeBinary: true,
    }),
  ])
  const baseFiles = snapshotMap(base)
  const branchFiles = snapshotMap(ours)
  const parentFiles = snapshotMap(theirs)
  const paths = new Set([
    ...baseFiles.keys(),
    ...branchFiles.keys(),
    ...parentFiles.keys(),
  ])
  const files = [...paths].sort().map(path => {
    const branchFile = branchFiles.get(path)
    const file = branchFile || baseFiles.get(path) || parentFiles.get(path)
    return {
      path,
      kind: file?.kind || 'file',
      state: classify(baseFiles.get(path), branchFile, parentFiles.get(path)),
    }
  })
  return {
    base_version: branch.baseVersion,
    branch_version: branchVersion.version,
    parent_version: parentVersion.version,
    files,
  }
}

async function mergeBranch(
  branchProjectId,
  userId,
  { dryRun = true, message } = {}
) {
  const branch = await getBranch(branchProjectId)
  await ProjectRef.requireAccess(userId, branch.parentProjectId, 'write')
  const result = await diffBranch(branchProjectId, userId)
  const [base, ours, theirs] = await Promise.all([
    SnapshotService.getSnapshot(branch.parentProjectId, result.base_version, {
      includeBinary: true,
    }),
    SnapshotService.getSnapshot(branch.branchProjectId, result.branch_version, {
      includeBinary: true,
    }),
    SnapshotService.getSnapshot(branch.parentProjectId, result.parent_version, {
      includeBinary: true,
    }),
  ])
  const baseFiles = snapshotMap(base)
  const branchFiles = snapshotMap(ours)
  const parentFiles = snapshotMap(theirs)
  const files = []
  const conflicts = []
  for (const entry of result.files) {
    const branchFile = branchFiles.get(entry.path)
    const parentFile = parentFiles.get(entry.path)
    const baseFile = baseFiles.get(entry.path)
    if (entry.state === 'branch_only') {
      if (!branchFile) files.push({ path: entry.path, delete: true })
      else if (branchFile.kind === 'doc')
        files.push({ path: entry.path, content: branchFile.content })
      else
        files.push({
          path: entry.path,
          contentBase64: (
            branchFile.buffer || (await branchFile.getBuffer())
          ).toString('base64'),
        })
    } else if (entry.state === 'both_differ') {
      if (
        branchFile?.kind === 'doc' &&
        parentFile?.kind === 'doc' &&
        baseFile?.kind === 'doc'
      ) {
        const merged = mergeText(
          branchFile.content,
          parentFile.content,
          baseFile.content
        )
        const hunkConflicts = (merged.hunks || []).flatMap(hunk =>
          (hunk.lines || [])
            .filter(line => line?.conflict)
            .map(line => ({ mine: line.mine, theirs: line.theirs }))
        )
        if (hunkConflicts.length)
          conflicts.push({ path: entry.path, conflicts: hunkConflicts })
        else
          files.push({
            path: entry.path,
            content: mergedContent(merged, baseFile.content),
          })
      } else
        conflicts.push({
          path: entry.path,
          conflicts: [{ mine: [], theirs: [] }],
        })
    }
  }
  const output = { mergeable: conflicts.length === 0, files, conflicts }
  if (dryRun || conflicts.length) return output
  const written = await WriteService.writeFiles(
    branch.parentProjectId,
    userId,
    {
      baseVersion: result.parent_version,
      message: message ?? `Merge branch ${branch.name}`,
      agent: 'mcp',
      files,
      originExtra: {
        merge: {
          branch: idOf(branch.branchProjectId),
          branchVersion: result.branch_version,
        },
      },
    }
  )
  const mergedVersion = written.version
  await SyncBranch.updateOne(
    { branchProjectId: branch.branchProjectId },
    { $set: { status: 'merged', mergedVersion, mergedAt: new Date() } }
  )
  return { ...output, version: mergedVersion, label: written.label }
}

async function archiveBranch(branchProjectId, userId) {
  const branch = await getBranch(branchProjectId)
  await ProjectRef.requireAccess(userId, branch.parentProjectId, 'read')
  await ProjectDeleter.promises.archiveProject(branch.branchProjectId, userId)
  await SyncBranch.updateOne(
    { branchProjectId: branch.branchProjectId },
    { $set: { status: 'archived' } }
  )
  return { branch_project_id: idOf(branch.branchProjectId), status: 'archived' }
}

export default {
  createBranch,
  listBranches,
  getBranch,
  diffBranch,
  mergeBranch,
  archiveBranch,
}
export {
  createBranch,
  listBranches,
  getBranch,
  diffBranch,
  mergeBranch,
  archiveBranch,
}
