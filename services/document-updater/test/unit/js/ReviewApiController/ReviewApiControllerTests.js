const sinon = require('sinon')
const { expect } = require('chai')
const modulePath = '../../../../app/js/ReviewApiController.js'
const SandboxedModule = require('sandboxed-module')
const Errors = require('../../../../app/js/Errors.js')

describe('ReviewApiController', function () {
  beforeEach(function () {
    this.project_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    this.doc_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    this.user_id = 'cccccccccccccccccccccccc'
    this.thread_id = 'dddddddddddddddddddddddd'
    this.CommentTextMismatchError = class extends Error {}
    this.ReviewApiManager = {
      CommentTextMismatchError: this.CommentTextMismatchError,
      promises: {
        suggestDocWithLock: sinon.stub(),
        rejectChangesWithLock: sinon.stub(),
        addCommentWithLock: sinon.stub(),
      },
    }
    this.Metrics = { Timer: class Timer {} }
    this.Metrics.Timer.prototype.done = sinon.stub()
    this.ReviewApiController = SandboxedModule.require(modulePath, {
      requires: {
        './ReviewApiManager': this.ReviewApiManager,
        './Errors': Errors,
        './Metrics': this.Metrics,
        '@overleaf/settings': { max_doc_length: 1024 },
      },
    })
    this.res = {
      json: sinon.stub(),
      sendStatus: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }
    this.call = async (handler, body) => {
      const next = sinon.stub()
      await this.ReviewApiController[handler](
        {
          params: { project_id: this.project_id, doc_id: this.doc_id },
          query: {},
          body,
        },
        this.res,
        next
      )
      // expressify does not return the handler's promise
      await new Promise(resolve => setImmediate(resolve))
      return next
    }
  })

  describe('suggestDoc', function () {
    beforeEach(function () {
      this.body = {
        lines: ['one', 'two'],
        source: { kind: 'mcp', agent: 'claude', suggestion: true },
        user_id: this.user_id,
      }
    })

    it('should return the change ids of the tracked write', async function () {
      this.ReviewApiManager.promises.suggestDocWithLock.resolves({
        rev: '7',
        changeIds: ['c1'],
      })
      await this.call('suggestDoc', this.body)
      this.ReviewApiManager.promises.suggestDocWithLock.should.have.been.calledWith(
        this.project_id,
        this.doc_id,
        this.body.lines,
        this.body.source,
        this.user_id
      )
      this.res.json.should.have.been.calledWith({
        rev: '7',
        change_ids: ['c1'],
      })
    })

    it('should accept a source string', async function () {
      this.ReviewApiManager.promises.suggestDocWithLock.resolves({
        changeIds: [],
      })
      const next = await this.call('suggestDoc', {
        ...this.body,
        source: 'review-api',
      })
      next.called.should.equal(false)
    })

    it('should reject an origin with fields history would not keep', async function () {
      const next = await this.call('suggestDoc', {
        ...this.body,
        source: { kind: 'mcp', revert: { from: 1, to: 2 } },
      })
      next.should.have.been.calledOnce
      this.ReviewApiManager.promises.suggestDocWithLock.called.should.equal(
        false
      )
    })

    it('should refuse a document that is too large', async function () {
      await this.call('suggestDoc', { ...this.body, lines: ['x'.repeat(2048)] })
      this.res.sendStatus.should.have.been.calledWith(406)
    })

    it('should answer 422 with a code for a history-ot document', async function () {
      this.ReviewApiManager.promises.suggestDocWithLock.rejects(
        new Errors.OTTypeMismatchError('history-ot', 'sharejs-text-ot')
      )
      await this.call('suggestDoc', this.body)
      this.res.status.should.have.been.calledWith(422)
      expect(this.res.json.firstCall.args[0].code).to.equal(
        'ot_type_unsupported'
      )
    })
  })

  describe('rejectChanges', function () {
    it('should reject the changes under the doc lock', async function () {
      this.ReviewApiManager.promises.rejectChangesWithLock.resolves({
        rejectedChangeIds: ['c1'],
      })
      await this.call('rejectChanges', {
        change_ids: ['c1'],
        user_id: this.user_id,
      })
      this.ReviewApiManager.promises.rejectChangesWithLock.should.have.been.calledWith(
        this.project_id,
        this.doc_id,
        ['c1'],
        this.user_id
      )
      this.res.json.should.have.been.calledWith({ rejectedChangeIds: ['c1'] })
    })

    it('should refuse a body without change ids', async function () {
      const next = await this.call('rejectChanges', { user_id: this.user_id })
      next.should.have.been.calledOnce
      this.ReviewApiManager.promises.rejectChangesWithLock.called.should.equal(
        false
      )
    })
  })

  describe('addComment', function () {
    beforeEach(function () {
      this.body = {
        thread_id: this.thread_id,
        position: 4,
        text: 'two',
        user_id: this.user_id,
      }
    })

    it('should return the comment and the new version', async function () {
      this.ReviewApiManager.promises.addCommentWithLock.resolves({
        comment: { id: this.thread_id },
        version: 43,
      })
      await this.call('addComment', this.body)
      this.ReviewApiManager.promises.addCommentWithLock.should.have.been.calledWith(
        this.project_id,
        this.doc_id,
        { threadId: this.thread_id, position: 4, text: 'two' },
        this.user_id
      )
      this.res.json.should.have.been.calledWith({
        comment: { id: this.thread_id },
        version: 43,
      })
    })

    for (const [name, change] of [
      ['a thread id that is not an object id', { thread_id: 'nope' }],
      ['a negative position', { position: -1 }],
      ['empty text', { text: '' }],
      ['a missing user id', { user_id: undefined }],
    ]) {
      it(`should refuse ${name}`, async function () {
        const next = await this.call('addComment', { ...this.body, ...change })
        next.should.have.been.calledOnce
        this.ReviewApiManager.promises.addCommentWithLock.called.should.equal(
          false
        )
      })
    }

    it('should answer 400 with the text that is actually there', async function () {
      const error = new this.CommentTextMismatchError('mismatch')
      error.info = { actualText: 'six' }
      this.ReviewApiManager.promises.addCommentWithLock.rejects(error)
      await this.call('addComment', this.body)
      this.res.status.should.have.been.calledWith(400)
      this.res.json.should.have.been.calledWith({
        code: 'text_mismatch',
        message: 'text does not match the document at this position',
        position: 4,
        actual_text: 'six',
      })
    })

    it('should pass a missing document on to the error handler', async function () {
      this.ReviewApiManager.promises.addCommentWithLock.rejects(
        new Errors.NotFoundError('not found')
      )
      const next = await this.call('addComment', this.body)
      next.should.have.been.calledOnce
      expect(next.firstCall.args[0]).to.be.instanceOf(Errors.NotFoundError)
    })
  })
})
