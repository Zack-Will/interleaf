import { beforeEach, describe, expect, it } from 'vitest'
import sinon from 'sinon'
import { createAgentUser } from '../../../app/src/AgentUser.mjs'

const projectId = '68c1f9a3e4b0c2d1a5f6e7b8'
const agentUserId = '5f6e7b868c1f9a3e4b0c2d1a'
const ownerId = '6f6e7b868c1f9a3e4b0c2d1a'
const otherUserId = '7f6e7b868c1f9a3e4b0c2d1a'

describe('review agent user', () => {
  beforeEach(ctx => {
    ctx.settings = {
      review: {
        agentUser: {
          email: 'agent@overleaf.local',
          firstName: 'Agent',
          lastName: 'MCP',
        },
      },
    }
    ctx.userGetter = {
      promises: { getUserByMainEmail: sinon.stub().resolves(null) },
    }
    ctx.userCreator = {
      promises: {
        createNewUser: sinon.stub().resolves({
          _id: agentUserId,
          email: 'agent@overleaf.local',
          first_name: 'Agent',
          last_name: 'MCP',
        }),
      },
    }
    ctx.collaboratorsGetter = {
      promises: {
        isUserInvitedMemberOfProject: sinon.stub().resolves(false),
      },
    }
    ctx.collaboratorsHandler = {
      promises: { addUserIdToProject: sinon.stub().resolves() },
    }
    ctx.projectGetter = {
      promises: { getProject: sinon.stub().resolves({ owner_ref: ownerId }) },
    }
    ctx.agentUser = createAgentUser({
      settings: ctx.settings,
      UserGetter: ctx.userGetter,
      UserCreator: ctx.userCreator,
      CollaboratorsGetter: ctx.collaboratorsGetter,
      CollaboratorsHandler: ctx.collaboratorsHandler,
      ProjectGetter: ctx.projectGetter,
    })
  })

  it('creates a passwordless service user with minimal features', async ctx => {
    const agent = await ctx.agentUser.ensureAgentUser()
    const attributes = ctx.userCreator.promises.createNewUser.firstCall.args[0]
    expect(attributes.email).toBe('agent@overleaf.local')
    expect(attributes.first_name).toBe('Agent')
    expect(attributes.last_name).toBe('MCP')
    expect(attributes.password).toBeUndefined()
    expect(attributes.features).toMatchObject({
      collaborators: 0,
      versioning: false,
      gitBridge: false,
    })
    expect(attributes.analyticsId).toEqual(expect.any(String))
    expect(agent).toEqual({
      id: agentUserId,
      email: 'agent@overleaf.local',
      name: 'Agent MCP',
    })
  })

  it('reuses an existing account and caches it', async ctx => {
    ctx.userGetter.promises.getUserByMainEmail.resolves({
      _id: agentUserId,
      email: 'agent@overleaf.local',
      first_name: 'Agent',
      last_name: 'MCP',
    })
    await ctx.agentUser.ensureAgentUser()
    await ctx.agentUser.ensureAgentUser()
    sinon.assert.calledOnce(ctx.userGetter.promises.getUserByMainEmail)
    sinon.assert.notCalled(ctx.userCreator.promises.createNewUser)
  })

  it('fails when no agent email is configured', async ctx => {
    ctx.settings.review = {}
    let error
    try {
      await ctx.agentUser.ensureAgentUser()
    } catch (caught) {
      error = caught
    }
    expect(error?.message).toBe('review.agentUser.email is not set')
  })

  it('adds the agent as a read and write collaborator for the owner', async ctx => {
    const result = await ctx.agentUser.ensureAgentIsCollaborator(
      projectId,
      ownerId
    )
    expect(result).toEqual({ ok: true, agentUserId, added: true })
    sinon.assert.calledWith(
      ctx.collaboratorsHandler.promises.addUserIdToProject,
      projectId,
      ownerId,
      agentUserId,
      'readAndWrite'
    )
  })

  it('does not add the agent twice', async ctx => {
    ctx.collaboratorsGetter.promises.isUserInvitedMemberOfProject.resolves(true)
    const result = await ctx.agentUser.ensureAgentIsCollaborator(
      projectId,
      ownerId
    )
    expect(result).toEqual({ ok: true, agentUserId, added: false })
    sinon.assert.notCalled(ctx.collaboratorsHandler.promises.addUserIdToProject)
  })

  it('refuses to add the agent when the acting user is not the owner', async ctx => {
    const result = await ctx.agentUser.ensureAgentIsCollaborator(
      projectId,
      otherUserId
    )
    expect(result).toEqual({ ok: false, reason: 'not_owner', agentUserId })
    sinon.assert.notCalled(ctx.collaboratorsHandler.promises.addUserIdToProject)
  })
})
