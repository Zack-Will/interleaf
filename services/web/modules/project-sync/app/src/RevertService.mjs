import SnapshotService from './SnapshotService.mjs'
import VersionService from './VersionService.mjs'
import WriteService from './WriteService.mjs'
import ProjectRef from './ProjectRef.mjs'
import { NotFoundAtVersionError } from './Errors.mjs'

async function revertTo(projectId, userId, { version, path, message, agent }) {
  await ProjectRef.requireAccess(userId, projectId, 'write')
  const current = await VersionService.promises.getLatestVersion(projectId)
  const snapshot = await SnapshotService.getSnapshot(projectId, version, {
    includeBinary: true,
  })
  const target = path
    ? snapshot.files.find(file => file.path === path.replace(/^\/+/, ''))
    : null
  if (path && !target)
    throw new NotFoundAtVersionError(`path not found at version ${version}`)
  const files = (path ? [target] : snapshot.files).map(file =>
    file.kind === 'doc'
      ? { path: file.path, content: file.content }
      : {
          path: file.path,
          contentBase64: (file.buffer || file.getBuffer()).toString('base64'),
        }
  )
  if (!path) {
    const targetPaths = new Set(snapshot.files.map(file => file.path))
    const tree = await SnapshotService.getFileTree(projectId)
    for (const file of tree)
      if (!targetPaths.has(file.path))
        files.push({ path: file.path, delete: true })
  }
  const revertMessage =
    message ?? `Revert ${path ?? 'project'} to version ${version}`
  const result = await WriteService.writeFiles(projectId, userId, {
    baseVersion: undefined,
    message: revertMessage,
    agent,
    files,
    originExtra: { revert: { from: current.version, to: version } },
    // A revert is a milestone by definition: it names a state of the project
    // somebody chose to come back to, so it always gets its label.
    label: true,
  })
  return {
    ...result,
    project_version: result.version,
    reverted_from_version: current.version,
    reverted_to_version: version,
  }
}
export default { revertTo, promises: { revertTo } }
