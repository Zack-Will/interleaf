import Settings from '@overleaf/settings'
import { InvalidProjectRefError, ProjectAccessError, ProjectNotFoundError } from './Errors.mjs'

function parse(input) {
  if (typeof input !== 'string') throw new InvalidProjectRefError()
  if (/^[0-9a-fA-F]{24}$/.test(input)) return { projectId: input.toLowerCase() }
  let pathname
  try { pathname = new URL(input).pathname } catch { throw new InvalidProjectRefError() }
  const idMatch = pathname.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/)
  if (!idMatch) throw new InvalidProjectRefError()
  return { projectId: idMatch[1].toLowerCase() }
}
function urlFor(projectId) { return `${Settings.siteUrl}/project/${projectId}` }
async function requireAccess(userId, projectId, level) {
  const { default: ProjectGetter } = await import('../../../../app/src/Features/Project/ProjectGetter.mjs')
  const project = await ProjectGetter.promises.getProject(projectId)
  if (project == null) throw new ProjectNotFoundError()
  const { default: AuthorizationManager } = await import('../../../../app/src/Features/Authorization/AuthorizationManager.mjs')
  const allowed = level === 'write'
    ? await AuthorizationManager.promises.canUserWriteProjectContent(userId, projectId, null)
    : await AuthorizationManager.promises.canUserReadProject(userId, projectId, null)
  if (!allowed) throw new ProjectAccessError()
  return true
}
export default { parse, urlFor, requireAccess }
export { parse, urlFor, requireAccess }
