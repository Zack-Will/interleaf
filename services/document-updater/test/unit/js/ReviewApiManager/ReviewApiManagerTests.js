const sinon = require('sinon')
const { expect } = require('chai')
const modulePath = '../../../../app/js/ReviewApiManager.js'
const SandboxedModule = require('sandboxed-module')
const Errors = require('../../../../app/js/Errors')
const tk = require('timekeeper')

describe('ReviewApiManager', function () {
  beforeEach(function () {
    tk.freeze(new Date())
    this.DocumentManager = {
      promises: {
        getDoc: sinon.stub(),
        setDoc: sinon.stub().resolves({ rev: '7' }),
        flushDocIfLoaded: sinon.stub().resolves(),
        flushAndDeleteDoc: sinon.stub().resolves(),
      },
    }
    this.HistoryManager = { flushProjectChangesAsync: sinon.stub() }
    this.UpdateManager = {
      promises: {
        applyUpdate: sinon.stub().resolves(),
        lockUpdatesAndDo: sinon
          .stub()
          .callsFake((method, ...args) => method(...args)),
      },
    }
    this.ReviewApiManager = SandboxedModule.require(modulePath, {
      requires: {
        './DocumentManager': this.DocumentManager,
        './HistoryManager': this.HistoryManager,
        './UpdateManager': this.UpdateManager,
        './Errors': Errors,
      },
    })
    this.project_id = 'project-id-123'
    this.doc_id = 'doc-id-123'
    this.user_id = 'user-id-123'
    this.version = 42
    this.stubGetDoc = (before = {}, after = {}) => {
      const getDoc = this.DocumentManager.promises.getDoc
      getDoc.onFirstCall().resolves({
        lines: ['one', 'two', 'three'],
        version: this.version,
        ranges: {},
        alreadyLoaded: true,
        type: 'sharejs-text-ot',
        ...before,
      })
      getDoc.onSecondCall().resolves({
        lines: ['one', 'two', 'three'],
        version: this.version + 1,
        ranges: {},
        alreadyLoaded: true,
        type: 'sharejs-text-ot',
        ...after,
      })
    }
  })

  afterEach(function () {
    tk.reset()
  })

  describe('suggestDoc', function () {
    beforeEach(function () {
      this.changeBefore = {
        id: '111111111111111111000001',
        op: { i: 'old', p: 0 },
        metadata: { user_id: this.user_id },
      }
      this.createdChange = {
        id: '333333333333333333000001',
        op: { i: 'foo', p: 4 },
        metadata: { user_id: this.user_id },
      }
      this.source = { kind: 'mcp', agent: 'claude', suggestion: true }
      this.suggest = () =>
        this.ReviewApiManager.promises.suggestDocWithLock(
          this.project_id,
          this.doc_id,
          ['one', 'foo two'],
          this.source,
          this.user_id
        )
    })

    it('should set the doc with tracked changes under the doc lock', async function () {
      this.stubGetDoc()
      await this.suggest()
      this.UpdateManager.promises.lockUpdatesAndDo.should.have.been.calledOnce
      this.DocumentManager.promises.setDoc.should.have.been.calledWith(
        this.project_id,
        this.doc_id,
        ['one', 'foo two'],
        this.source,
        this.user_id,
        false,
        true,
        true
      )
    })

    it('should return the ids of the changes it created with the setDoc result', async function () {
      this.stubGetDoc(
        { ranges: { changes: [this.changeBefore] } },
        { ranges: { changes: [this.changeBefore, this.createdChange] } }
      )
      const result = await this.suggest()
      expect(result).to.deep.equal({
        rev: '7',
        changeIds: [this.createdChange.id],
      })
    })

    it('should include a change of the same user that this update grew', async function () {
      const grown = { ...this.changeBefore, op: { i: 'older', p: 0 } }
      this.stubGetDoc(
        { ranges: { changes: [this.changeBefore] } },
        { ranges: { changes: [grown] } }
      )
      const result = await this.suggest()
      expect(result.changeIds).to.deep.equal([grown.id])
    })

    it('should ignore a change of the same user that only shifted along', async function () {
      const shifted = { ...this.changeBefore, op: { i: 'old', p: 30 } }
      this.stubGetDoc(
        { ranges: { changes: [this.changeBefore] } },
        { ranges: { changes: [shifted, this.createdChange] } }
      )
      const result = await this.suggest()
      expect(result.changeIds).to.deep.equal([this.createdChange.id])
    })

    it('should ignore changed changes of other users', async function () {
      const other = {
        id: '222222222222222222000001',
        op: { i: 'theirs', p: 90 },
        metadata: { user_id: 'someone-else' },
      }
      this.stubGetDoc(
        { ranges: { changes: [other] } },
        {
          ranges: {
            changes: [
              { ...other, op: { i: 'their', p: 90 } },
              this.createdChange,
            ],
          },
        }
      )
      const result = await this.suggest()
      expect(result.changeIds).to.deep.equal([this.createdChange.id])
    })

    it('should leave a doc that was already loaded in redis', async function () {
      this.stubGetDoc()
      await this.suggest()
      this.DocumentManager.promises.flushDocIfLoaded.should.have.been.calledWith(
        this.project_id,
        this.doc_id
      )
      this.DocumentManager.promises.flushAndDeleteDoc.called.should.equal(false)
    })

    it('should evict a doc it loaded and flush project history', async function () {
      this.stubGetDoc({ alreadyLoaded: false })
      await this.suggest()
      this.DocumentManager.promises.flushAndDeleteDoc.should.have.been.calledWith(
        this.project_id,
        this.doc_id,
        {}
      )
      this.HistoryManager.flushProjectChangesAsync.should.have.been.calledWith(
        this.project_id
      )
    })

    it('should refuse a history-ot document', async function () {
      this.stubGetDoc({ type: 'history-ot', lines: { content: 'one' } })
      await expect(this.suggest()).to.be.rejectedWith(
        Errors.OTTypeMismatchError
      )
      this.DocumentManager.promises.setDoc.called.should.equal(false)
    })

    it('should refuse a missing document', async function () {
      this.stubGetDoc({ lines: null, version: null })
      await expect(this.suggest()).to.be.rejectedWith(Errors.NotFoundError)
    })
  })

  describe('rejectChanges', function () {
    beforeEach(function () {
      this.stubGetDoc({
        ranges: {
          changes: [
            { id: 'insert-1', op: { i: 'quux', p: 4 } },
            { id: 'delete-1', op: { d: 'bar', p: 8 } },
            { id: 'other-1', op: { i: 'keep', p: 20 } },
          ],
        },
      })
    })

    it('should apply the inverse ops, last position first', async function () {
      const result = await this.ReviewApiManager.promises.rejectChangesWithLock(
        this.project_id,
        this.doc_id,
        ['insert-1', 'delete-1'],
        this.user_id
      )
      this.UpdateManager.promises.applyUpdate.should.have.been.calledWith(
        this.project_id,
        this.doc_id,
        {
          doc: this.doc_id,
          op: [
            { p: 8, i: 'bar', u: true },
            { p: 4, d: 'quux', u: true },
          ],
          v: this.version,
          meta: { user_id: this.user_id, ts: new Date().toISOString() },
        }
      )
      expect(result).to.deep.equal({
        rejectedChangeIds: ['delete-1', 'insert-1'],
      })
    })

    it('should not apply an update when no id matches', async function () {
      const result = await this.ReviewApiManager.promises.rejectChanges(
        this.project_id,
        this.doc_id,
        ['missing'],
        this.user_id
      )
      this.UpdateManager.promises.applyUpdate.called.should.equal(false)
      expect(result).to.deep.equal({ rejectedChangeIds: [] })
    })
  })

  describe('addComment', function () {
    beforeEach(function () {
      this.thread_id = '0123456789abcdef01234567'
      this.newComment = {
        id: this.thread_id,
        op: { c: 'two', p: 4, t: this.thread_id },
        metadata: { user_id: this.user_id, ts: new Date() },
      }
      this.addComment = (text = 'two') =>
        this.ReviewApiManager.promises.addCommentWithLock(
          this.project_id,
          this.doc_id,
          { threadId: this.thread_id, position: 4, text },
          this.user_id
        )
    })

    describe('successfully', function () {
      beforeEach(async function () {
        this.stubGetDoc({}, { ranges: { comments: [this.newComment] } })
        this.result = await this.addComment()
      })

      it('should apply a comment op at the requested position', function () {
        this.UpdateManager.promises.applyUpdate.should.have.been.calledWith(
          this.project_id,
          this.doc_id,
          {
            doc: this.doc_id,
            op: [{ c: 'two', p: 4, t: this.thread_id }],
            v: this.version,
            meta: {
              user_id: this.user_id,
              ts: Date.now(),
              source: 'review-api',
            },
          }
        )
      })

      it('should return the comment read back from the new ranges', function () {
        expect(this.result).to.deep.equal({
          comment: this.newComment,
          version: this.version + 1,
        })
      })

      it('should flush the doc that is already loaded', function () {
        this.DocumentManager.promises.flushDocIfLoaded.should.have.been.calledWith(
          this.project_id,
          this.doc_id
        )
        this.DocumentManager.promises.flushAndDeleteDoc.called.should.equal(
          false
        )
      })
    })

    describe('when the doc was not loaded', function () {
      it('should evict the doc again and flush project history', async function () {
        this.stubGetDoc(
          { alreadyLoaded: false },
          { ranges: { comments: [this.newComment] } }
        )
        await this.addComment()
        this.DocumentManager.promises.flushAndDeleteDoc.should.have.been.calledWith(
          this.project_id,
          this.doc_id,
          {}
        )
        this.HistoryManager.flushProjectChangesAsync.should.have.been.calledWith(
          this.project_id
        )
      })
    })

    describe('when the text does not match the document', function () {
      beforeEach(function () {
        this.stubGetDoc()
      })

      it('should throw a CommentTextMismatchError carrying the actual text', async function () {
        const error = await this.addComment('six').catch(error => error)
        expect(error).to.be.instanceOf(
          this.ReviewApiManager.CommentTextMismatchError
        )
        expect(error.info.actualText).to.equal('two')
        this.UpdateManager.promises.applyUpdate.called.should.equal(false)
      })
    })

    describe('when the document uses history-ot', function () {
      it('should throw an OTTypeMismatchError', async function () {
        this.stubGetDoc({ type: 'history-ot', lines: { content: 'one' } })
        await expect(this.addComment()).to.be.rejectedWith(
          Errors.OTTypeMismatchError
        )
        this.UpdateManager.promises.applyUpdate.called.should.equal(false)
      })
    })

    describe('when the comment is missing from the new ranges', function () {
      it('should throw a NotFoundError', async function () {
        this.stubGetDoc({}, { ranges: { comments: [] } })
        await expect(this.addComment()).to.be.rejectedWith(Errors.NotFoundError)
      })
    })
  })
})
