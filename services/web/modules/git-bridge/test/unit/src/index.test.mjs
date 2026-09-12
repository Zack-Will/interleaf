import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'

async function loadModule(ctx, settings) {
  vi.resetModules()
  ctx.fetchNothing = sinon.stub().resolves()
  vi.doMock('@overleaf/settings', () => ({ default: settings }))
  vi.doMock('@overleaf/fetch-utils', () => ({
    fetchNothing: ctx.fetchNothing,
    fetchStream: sinon.stub(),
  }))
  vi.doMock('../../../app/src/GitBridgeRouter.mjs', () => ({
    default: { apply: sinon.stub(), createDefaultServices: sinon.stub() },
  }))
  return await import('../../../index.mjs')
}

describe('git-bridge module', () => {
  beforeEach(async ctx => {
    ctx.loaded = await loadModule(ctx, {
      enableGitBridge: true,
      apis: { gitBridge: { url: 'http://git-bridge:8000/' } },
    })
  })

  it('declares project-sync as a dependency and registers a nonCsrfRouter', ctx => {
    const module = ctx.loaded.default
    expect(module.dependencies).toEqual(['project-sync'])
    expect(typeof module.nonCsrfRouter.apply).toEqual('function')
  })

  it('tells git-bridge to drop the repository when a project expires', async ctx => {
    await ctx.loaded.default.hooks.promises.projectExpired(PROJECT_ID)
    sinon.assert.calledOnce(ctx.fetchNothing)
    const [url, options] = ctx.fetchNothing.firstCall.args
    expect(url).toEqual(`http://git-bridge:8000/api/projects/${PROJECT_ID}`)
    expect(options.method).toEqual('DELETE')
  })

  it('swallows git-bridge deletion failures', async ctx => {
    ctx.fetchNothing.rejects(new Error('connection refused'))
    const result =
      await ctx.loaded.default.hooks.promises.projectExpired(PROJECT_ID)
    expect(result).toBeUndefined()
  })

  it('does nothing when git-bridge is disabled', async ctx => {
    const loaded = await loadModule(ctx, { enableGitBridge: false })
    await loaded.notifyProjectDeleted(PROJECT_ID)
    sinon.assert.notCalled(ctx.fetchNothing)
  })
})
