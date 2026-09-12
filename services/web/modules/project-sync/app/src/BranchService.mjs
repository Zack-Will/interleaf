// eslint-disable-next-line import/no-extraneous-dependencies -- diff is a web dependency
import { applyPatch, merge as mergeText } from 'diff'
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

async function getBranch(branchProjectId) {
  const record = await SyncBranch.findOne({ branchProjectId })
  if (!record) throw new BranchNotFoundError()
  return record
}

async function loadThreeWay(branch) {
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
  return { branchVersion, parentVersion, base, ours, theirs }
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
  const { branchVersion, parentVersion, base, ours, theirs } =
    await loadThreeWay(branch)
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
  { dryRun = true, message, agent = 'mcp' } = {}
) {
  const branch = await getBranch(branchProjectId)
  await ProjectRef.requireAccess(userId, branch.parentProjectId, 'write')
  await ProjectRef.requireAccess(userId, branch.branchProjectId, 'read')
  const { branchVersion, parentVersion, base, ours, theirs } =
    await loadThreeWay(branch)
  const baseFiles = snapshotMap(base)
  const branchFiles = snapshotMap(ours)
  const parentFiles = snapshotMap(theirs)
  const paths = new Set([
    ...baseFiles.keys(),
    ...branchFiles.keys(),
    ...parentFiles.keys(),
  ])
  const files = []
  const conflicts = []
  for (const path of [...paths].sort()) {
    const branchFile = branchFiles.get(path)
    const parentFile = parentFiles.get(path)
    const baseFile = baseFiles.get(path)
    const state = classify(baseFile, branchFile, parentFile)
    if (state === 'branch_only') {
      if (!branchFile) files.push({ path, delete: true })
      else if (branchFile.kind === 'doc')
        files.push({ path, content: branchFile.content })
      else
        files.push({
          path,
          contentBase64: (
            branchFile.buffer || (await branchFile.getBuffer())
          ).toString('base64'),
        })
    } else if (state === 'both_differ') {
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
          conflicts.push({ path, conflicts: hunkConflicts })
        else {
          const content = applyPatch(baseFile.content, merged)
          if (content === false)
            conflicts.push({ path, conflicts: [{ reason: 'apply_failed' }] })
          else files.push({ path, content })
        }
      } else {
        let reason = 'binary_both_changed'
        if (!branchFile && parentFile)
          reason = 'deleted_in_branch_modified_in_parent'
        else if (branchFile && !parentFile)
          reason = 'modified_in_branch_deleted_in_parent'
        conflicts.push({
          path,
          conflicts: [{ mine: [], theirs: [], reason }],
        })
      }
    }
  }
  const output = {
    mergeable: conflicts.length === 0,
    files,
    conflicts,
    branch_version: branchVersion.version,
    parent_version: parentVersion.version,
    base_version: branch.baseVersion,
  }
  if (dryRun || conflicts.length) return output
  const written = await WriteService.writeFiles(
    branch.parentProjectId,
    userId,
    {
      baseVersion: parentVersion.version,
      message: message ?? `Merge branch ${branch.name}`,
      agent,
      files,
      originExtra: {
        merge: {
          branch: idOf(branch.branchProjectId),
          branchVersion: branchVersion.version,
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
