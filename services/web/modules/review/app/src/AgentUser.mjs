// The service account an MCP agent speaks as when it replies to or resolves a
// comment.  Having a real user means the review panel shows "Agent MCP" next
// to every agent message instead of attributing it to the human whose access
// token the agent is using.
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import CollaboratorsGetter from '../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs'
import CollaboratorsHandler from '../../../../app/src/Features/Collaborators/CollaboratorsHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'

// The account is never meant to log in or to own anything: it gets no
// password, and every paid-shaped feature stays off.  Track changes is left on
// because that is what lets it take part in review threads.
const AGENT_USER_FEATURES = {
  collaborators: 0,
  versioning: false,
  dropbox: false,
  github: false,
  gitBridge: false,
  compileTimeout: 60,
  compileGroup: 'standard',
  references: false,
  referencesSearch: false,
  symbolPalette: false,
  trackChanges: true,
  mendeley: false,
  zotero: false,
  papers: false,
}

const USER_PROJECTION = { _id: 1, email: 1, first_name: 1, last_name: 1 }

function displayName(user, config) {
  const first = user?.first_name || config.firstName || ''
  const last = user?.last_name || config.lastName || ''
  return `${first} ${last}`.trim()
}

export function createAgentUser(services = {}) {
  const settings = services.settings || Settings
  const userGetter = services.UserGetter || UserGetter
  const userCreator = services.UserCreator || UserCreator
  const collaboratorsGetter =
    services.CollaboratorsGetter || CollaboratorsGetter
  const collaboratorsHandler =
    services.CollaboratorsHandler || CollaboratorsHandler
  const projectGetter = services.ProjectGetter || ProjectGetter

  // Resolving the account costs a Mongo round trip per call otherwise, and it
  // never changes while the process is up.
  let cachedAgentUser = null

  function agentUserConfig() {
    const config = settings.review?.agentUser || {}
    if (!config.email) throw new Error('review.agentUser.email is not set')
    return config
  }

  async function ensureAgentUser() {
    if (cachedAgentUser) return cachedAgentUser
    const config = agentUserConfig()
    let user = await userGetter.promises.getUserByMainEmail(
      config.email,
      USER_PROJECTION
    )
    if (!user) {
      user = await userCreator.promises.createNewUser(
        {
          email: config.email,
          first_name: config.firstName || 'Agent',
          last_name: config.lastName || '',
          holdingAccount: false,
          analyticsId: crypto.randomUUID(),
          features: AGENT_USER_FEATURES,
        },
        {}
      )
      logger.info(
        { email: config.email, userId: String(user._id) },
        'created the review agent service user'
      )
    }
    cachedAgentUser = {
      id: String(user._id),
      email: user.email || config.email,
      name: displayName(user, config),
    }
    return cachedAgentUser
  }

  async function isProjectOwner(projectId, userId) {
    if (!userId) return false
    const project = await projectGetter.promises.getProject(projectId, {
      owner_ref: 1,
    })
    return String(project?.owner_ref || '') === String(userId)
  }

  // The agent can only be added to a project by its owner.  Callers that get
  // `not_owner` back fall back to acting as the token user.
  async function ensureAgentIsCollaborator(projectId, actingUserId) {
    const agent = await ensureAgentUser()
    if (String(actingUserId) === agent.id) {
      return { ok: true, agentUserId: agent.id, added: false }
    }
    const alreadyMember =
      await collaboratorsGetter.promises.isUserInvitedMemberOfProject(
        agent.id,
        projectId
      )
    if (alreadyMember) {
      return { ok: true, agentUserId: agent.id, added: false }
    }
    if (!(await isProjectOwner(projectId, actingUserId))) {
      return { ok: false, reason: 'not_owner', agentUserId: agent.id }
    }
    await collaboratorsHandler.promises.addUserIdToProject(
      projectId,
      actingUserId,
      agent.id,
      PrivilegeLevels.READ_AND_WRITE
    )
    logger.info(
      { projectId, agentUserId: agent.id },
      'added the review agent service user to a project'
    )
    return { ok: true, agentUserId: agent.id, added: true }
  }

  return { ensureAgentUser, ensureAgentIsCollaborator }
}

const AgentUser = createAgentUser()

export default AgentUser
