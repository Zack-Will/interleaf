import { beforeEach, describe, expect, it } from 'vitest'
import sinon from 'sinon'
import { createReviewService } from '../../../app/src/ReviewService.mjs'

const projectId = '68c1f9a3e4b0c2d1a5f6e7b8'
const docId = '5f6e7b868c1f9a3e4b0c2d1a'
const threadId = '6f6e7b868c1f9a3e4b0c2d1a'

describe('review service', () => {
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
      },
    }
    ctx.chatManager = {
      promises: { injectUserInfoIntoThreads: sinon.stub().resolves() },
    }
    ctx.documentUpdater = {
      promises: {
        getDocument: sinon.stub().resolves({
          lines: ['one', 'two'],
          version: 7,
          ranges: {
            comments: [{ id: 'c1', op: { c: 'one', p: 0, t: 'tid' } }],
          },
        }),
        resolveThread: sinon.stub().resolves(),
        reopenThread: sinon.stub().resolves(),
        deleteThread: sinon.stub().resolves(),
      },
    }
    ctx.projectGetter = {
      promises: {
        getProject: sinon
          .stub()
          .resolves({ overleaf: { history: { rangesSupportEnabled: true } } }),
      },
    }
    ctx.realtime = { emitToRoom: sinon.stub() }
    ctx.userInfoManager = {
      promises: {
        getPersonalInfo: sinon.stub().resolves({ _id: 'user-1' }),
      },
    }
    ctx.userInfoController = {
      formatPersonalInfo: sinon.stub().returns({ id: 'user-1' }),
    }
    ctx.documentUpdaterClient = {
      promises: {
        addCommentRange: sinon.stub().resolves({
          comment: { id: threadId, op: { c: 'one', p: 0, t: threadId } },
          version: 8,
        }),
      },
    }
    ctx.service = createReviewService({
      ChatApiHandler: ctx.chatApi,
      ChatManager: ctx.chatManager,
      DocumentUpdaterHandler: ctx.documentUpdater,
      DocumentUpdaterClient: ctx.documentUpdaterClient,
      ProjectGetter: ctx.projectGetter,
      EditorRealTimeController: ctx.realtime,
      UserInfoManager: ctx.userInfoManager,
      UserInfoController: ctx.userInfoController,
      generateThreadId: () => threadId,
    })
  })

  it('injects user information into listed threads', async ctx => {
    const threads = await ctx.service.listThreads(projectId)
    sinon.assert.calledOnce(ctx.chatManager.promises.injectUserInfoIntoThreads)
    expect(threads).toEqual({ [threadId]: { messages: [] } })
  })

  it('broadcasts a sent comment with its formatted user', async ctx => {
    const message = await ctx.service.sendComment(
      projectId,
      threadId,
      'user-1',
      'hello'
    )
    expect(message.user).toEqual({ id: 'user-1' })
    sinon.assert.calledWith(
      ctx.realtime.emitToRoom,
      projectId,
      'new-comment',
      threadId,
      sinon.match({ user: { id: 'user-1' } })
    )
  })

  it('mirrors resolve to document updater only when ranges support is enabled', async ctx => {
    await ctx.service.resolveThread(projectId, docId, threadId, 'user-1')
    sinon.assert.calledOnce(ctx.documentUpdater.promises.resolveThread)
    ctx.projectGetter.promises.getProject.resolves({})
    await ctx.service.resolveThread(projectId, docId, threadId, 'user-1')
    sinon.assert.calledTwice(ctx.chatApi.promises.resolveThread)
    sinon.assert.calledOnce(ctx.documentUpdater.promises.resolveThread)
  })

  it('mirrors reopen to document updater only when ranges support is enabled', async ctx => {
    ctx.projectGetter.promises.getProject.resolves({})
    await ctx.service.reopenThread(projectId, docId, threadId, 'user-1')
    sinon.assert.calledOnce(ctx.chatApi.promises.reopenThread)
    sinon.assert.notCalled(ctx.documentUpdater.promises.reopenThread)
    sinon.assert.calledWith(
      ctx.realtime.emitToRoom,
      projectId,
      'reopen-thread',
      threadId
    )
  })

  it('deletes the range before the chat thread', async ctx => {
    await ctx.service.deleteThread(projectId, docId, threadId, 'user-1')
    sinon.assert.callOrder(
      ctx.documentUpdater.promises.deleteThread,
      ctx.chatApi.promises.deleteThread
    )
  })

  it('creates the chat thread before the comment range', async ctx => {
    const result = await ctx.service.createComment(projectId, docId, 'user-1', {
      position: 0,
      text: 'one',
      content: 'please rephrase',
    })
    sinon.assert.callOrder(
      ctx.chatApi.promises.sendComment,
      ctx.documentUpdaterClient.promises.addCommentRange
    )
    sinon.assert.calledWith(
      ctx.chatApi.promises.sendComment,
      projectId,
      threadId,
      'user-1',
      'please rephrase'
    )
    sinon.assert.calledWith(
      ctx.documentUpdaterClient.promises.addCommentRange,
      projectId,
      docId,
      'user-1',
      { threadId, position: 0, text: 'one' }
    )
    expect(result.threadId).toBe(threadId)
    expect(result.version).toBe(8)
    expect(result.comment.op.t).toBe(threadId)
  })

  it('deletes the thread again when the comment range cannot be created', async ctx => {
    const failure = Object.assign(new Error('text mismatch'), {
      code: 'text_mismatch',
      actualText: 'two',
    })
    ctx.documentUpdaterClient.promises.addCommentRange.rejects(failure)
    const error = await ctx.service
      .createComment(projectId, docId, 'user-1', {
        position: 0,
        text: 'one',
        content: 'please rephrase',
      })
      .catch(error => error)
    expect(error).toBe(failure)
    sinon.assert.calledWith(
      ctx.chatApi.promises.deleteThread,
      projectId,
      threadId
    )
    sinon.assert.calledWith(
      ctx.realtime.emitToRoom,
      projectId,
      'delete-thread',
      threadId
    )
  })

  it('still reports the original failure when the rollback fails', async ctx => {
    ctx.documentUpdaterClient.promises.addCommentRange.rejects(
      new Error('document-updater is down')
    )
    ctx.chatApi.promises.deleteThread.rejects(new Error('chat is down too'))
    const error = await ctx.service
      .createComment(projectId, docId, 'user-1', {
        position: 0,
        text: 'one',
        content: 'please rephrase',
      })
      .catch(error => error)
    expect(error.message).toBe('document-updater is down')
  })

  it('re-anchors an existing thread with the same thread id', async ctx => {
    const result = await ctx.service.reanchorComment(
      projectId,
      docId,
      'user-1',
      threadId,
      { position: 4, text: 'two' }
    )
    sinon.assert.calledWith(
      ctx.documentUpdaterClient.promises.addCommentRange,
      projectId,
      docId,
      'user-1',
      { threadId, position: 4, text: 'two' }
    )
    sinon.assert.notCalled(ctx.chatApi.promises.sendComment)
    expect(result).toEqual({
      threadId,
      comment: { id: threadId, op: { c: 'one', p: 0, t: threadId } },
      version: 8,
    })
  })

  it('refuses to re-anchor a thread that does not exist', async ctx => {
    const error = await ctx.service
      .reanchorComment(projectId, docId, 'user-1', 'missing-thread', {
        position: 4,
        text: 'two',
      })
      .catch(error => error)
    expect(error.code).toBe('thread_not_found')
    sinon.assert.notCalled(ctx.documentUpdaterClient.promises.addCommentRange)
  })

  it('propagates a text mismatch from re-anchoring', async ctx => {
    const failure = Object.assign(new Error('text mismatch'), {
      code: 'text_mismatch',
      actualText: 'three',
    })
    ctx.documentUpdaterClient.promises.addCommentRange.rejects(failure)
    const error = await ctx.service
      .reanchorComment(projectId, docId, 'user-1', threadId, {
        position: 4,
        text: 'two',
      })
      .catch(error => error)
    expect(error.code).toBe('text_mismatch')
    expect(error.actualText).toBe('three')
  })

  it('returns live lines and ranges for a document', async ctx => {
    const document = await ctx.service.getDocRanges(projectId, docId)
    sinon.assert.calledWith(
      ctx.documentUpdater.promises.getDocument,
      projectId,
      docId,
      -1
    )
    expect(document.lines).toEqual(['one', 'two'])
    expect(document.version).toBe(7)
    expect(document.ranges.comments).toHaveLength(1)
  })

  it('splits string document content into lines', async ctx => {
    ctx.documentUpdater.promises.getDocument.resolves({ lines: 'a\nb' })
    const document = await ctx.service.getDocRanges(projectId, docId)
    expect(document.lines).toEqual(['a', 'b'])
    expect(document.ranges).toEqual({})
  })
})
