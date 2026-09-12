import { beforeEach, describe, it } from 'vitest'
import sinon from 'sinon'
import { createHandlers } from '../../../app/src/ReviewController.mjs'

const projectId = '68c1f9a3e4b0c2d1a5f6e7b8'
const docId = '5f6e7b868c1f9a3e4b0c2d1a'
const threadId = '6f6e7b868c1f9a3e4b0c2d1a'

function response() {
  return {
    json: sinon.stub(),
    sendStatus: sinon.stub(),
  }
}

function request(params = {}, body = {}, userId = 'user-1') {
  return { params, body, session: { userId } }
}

describe('review controller', () => {
  beforeEach(ctx => {
    ctx.chatApi = {
      promises: {
        getThreads: sinon.stub().resolves({ [threadId]: { messages: [] } }),
        sendComment: sinon
          .stub()
          .resolves({ id: 'message-1', user_id: 'user-1', content: 'hello' }),
        resolveThread: sinon.stub().resolves(),
        reopenThread: sinon.stub().resolves(),
        deleteThread: sinon.stub().resolves(),
        editMessage: sinon.stub().resolves(),
        deleteMessage: sinon.stub().resolves(),
        deleteUserMessage: sinon.stub().resolves(),
      },
    }
    ctx.chatManager = {
      promises: { injectUserInfoIntoThreads: sinon.stub().resolves() },
    }
    ctx.documentUpdater = {
      promises: {
        flushProjectToMongo: sinon.stub().resolves(),
        resolveThread: sinon.stub().resolves(),
        reopenThread: sinon.stub().resolves(),
        deleteThread: sinon.stub().resolves(),
        acceptChanges: sinon.stub().resolves(),
      },
    }
    ctx.docstore = {
      promises: {
        getAllRanges: sinon
          .stub()
          .resolves([{ _id: docId, ranges: { comments: [] } }]),
      },
    }
    ctx.projectGetter = {
      promises: {
        getProject: sinon
          .stub()
          .resolves({ overleaf: { history: { rangesSupportEnabled: true } } }),
      },
    }
    ctx.projectOptions = {
      promises: { setTrackChanges: sinon.stub().resolves() },
    }
    ctx.realtime = { emitToRoom: sinon.stub() }
    ctx.sessionManager = { getLoggedInUserId: sinon.stub().returns('user-1') }
    ctx.userInfoManager = {
      promises: {
        getPersonalInfo: sinon.stub().resolves({
          _id: 'user-1',
          email: 'a@example.com',
          first_name: 'Ada',
        }),
      },
    }
    ctx.userInfoController = {
      formatPersonalInfo: sinon
        .stub()
        .returns({ id: 'user-1', email: 'a@example.com', first_name: 'Ada' }),
    }
    ctx.handlers = createHandlers({
      ChatApiHandler: ctx.chatApi,
      ChatManager: ctx.chatManager,
      DocumentUpdaterHandler: ctx.documentUpdater,
      DocstoreManager: ctx.docstore,
      ProjectGetter: ctx.projectGetter,
      ProjectOptionsHandler: ctx.projectOptions,
      EditorRealTimeController: ctx.realtime,
      SessionManager: ctx.sessionManager,
      UserInfoManager: ctx.userInfoManager,
      UserInfoController: ctx.userInfoController,
    })
  })

  it('lists threads after injecting user information', async ctx => {
    const res = response()
    await ctx.handlers.getThreads(request({ project_id: projectId }), res)
    sinon.assert.calledOnce(ctx.chatManager.promises.injectUserInfoIntoThreads)
    sinon.assert.calledWith(res.json, { [threadId]: { messages: [] } })
  })

  it('broadcasts a sent comment with its formatted user', async ctx => {
    const res = response()
    await ctx.handlers.sendComment(
      request(
        { project_id: projectId, thread_id: threadId },
        { content: 'hello' }
      ),
      res
    )
    sinon.assert.calledWith(
      ctx.realtime.emitToRoom,
      projectId,
      'new-comment',
      threadId,
      sinon.match({ user: { id: 'user-1' } })
    )
    sinon.assert.calledWith(res.sendStatus, 204)
  })

  it('mirrors resolve to document updater only when ranges support is enabled', async ctx => {
    const res = response()
    await ctx.handlers.resolveThread(
      request({ project_id: projectId, doc_id: docId, thread_id: threadId }),
      res
    )
    sinon.assert.calledOnce(ctx.chatApi.promises.resolveThread)
    sinon.assert.calledOnce(ctx.documentUpdater.promises.resolveThread)
    ctx.projectGetter.promises.getProject.resolves({})
    await ctx.handlers.resolveThread(
      request({ project_id: projectId, doc_id: docId, thread_id: threadId }),
      response()
    )
    sinon.assert.calledTwice(ctx.chatApi.promises.resolveThread)
    sinon.assert.calledOnce(ctx.documentUpdater.promises.resolveThread)
  })

  it('deletes the range and chat thread', async ctx => {
    const res = response()
    await ctx.handlers.deleteThread(
      request({ project_id: projectId, doc_id: docId, thread_id: threadId }),
      res
    )
    sinon.assert.calledOnce(ctx.documentUpdater.promises.deleteThread)
    sinon.assert.calledOnce(ctx.chatApi.promises.deleteThread)
    sinon.assert.calledWith(
      ctx.realtime.emitToRoom,
      projectId,
      'delete-thread',
      threadId
    )
  })

  it('rejects anonymous comments', async ctx => {
    ctx.sessionManager.getLoggedInUserId.returns(null)
    const res = response()
    await ctx.handlers.sendComment(
      request(
        { project_id: projectId, thread_id: threadId },
        { content: 'hello' },
        null
      ),
      res
    )
    sinon.assert.calledWith(res.sendStatus, 403)
    sinon.assert.notCalled(ctx.chatApi.promises.sendComment)
  })
})
