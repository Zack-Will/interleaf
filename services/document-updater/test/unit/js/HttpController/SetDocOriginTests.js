// Interleaf: setDoc must accept the origin object web sends for MCP and
// git-bridge writes, not only a source string. Kept apart from upstream's
// HttpControllerTests.js so that file merges cleanly.
const sinon = require('sinon')
const { expect } = require('chai')
const SandboxedModule = require('sandboxed-module')
const modulePath = '../../../../app/js/HttpController.js'
const Errors = require('../../../../app/js/Errors.js')

describe('SetDocOrigin: HttpController.setDoc with an origin object', function () {
  beforeEach(function () {
    this.DocumentManager = {
      promises: { setDocWithLock: sinon.stub().resolves({ rev: '1' }) },
    }
    this.Metrics = { Timer: class Timer {} }
    this.Metrics.Timer.prototype.done = sinon.stub()
    this.HttpController = SandboxedModule.require(modulePath, {
      requires: {
        './DocumentManager': this.DocumentManager,
        './HistoryManager': {},
        './ProjectHistoryRedisManager': {},
        './ProjectManager': {},
        './DeleteQueueManager': {},
        './RedisManager': {},
        './Metrics': this.Metrics,
        './Errors': Errors,
        './Utils': {},
        './HistoryConversions': {},
        '@overleaf/settings': { max_doc_length: 2 * 1024 * 1024 },
      },
    })
    this.res = {
      json: sinon.stub(),
      sendStatus: sinon.stub(),
      status: sinon.stub().returnsThis(),
      send: sinon.stub(),
    }
    this.setDoc = async source => {
      const next = sinon.stub()
      this.HttpController.setDoc(
        {
          params: {
            project_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            doc_id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          },
          query: {},
          body: {
            lines: ['one'],
            source,
            user_id: 'cccccccccccccccccccccccc',
          },
        },
        this.res,
        next
      )
      await new Promise(resolve => setImmediate(resolve))
      return next
    }
  })

  it('passes an MCP origin through to setDocWithLock', async function () {
    const origin = { kind: 'mcp', agent: 'Claude Code', message: 'Tighten' }
    const next = await this.setDoc(origin)
    next.called.should.equal(false)
    expect(
      this.DocumentManager.promises.setDocWithLock.firstCall.args[3]
    ).to.deep.equal(origin)
    this.res.json.should.have.been.calledWith({ rev: '1' })
  })

  it('still accepts a source string', async function () {
    const next = await this.setDoc('editor')
    next.called.should.equal(false)
    this.DocumentManager.promises.setDocWithLock.called.should.equal(true)
  })

  it('refuses an origin with fields history does not keep', async function () {
    const next = await this.setDoc({ kind: 'mcp', revert: { from: 1, to: 2 } })
    next.called.should.equal(true)
    this.DocumentManager.promises.setDocWithLock.called.should.equal(false)
  })
})
