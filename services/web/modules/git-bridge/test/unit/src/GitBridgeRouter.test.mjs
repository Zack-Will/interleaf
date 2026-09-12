import { describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

function fakeRouter() {
  const routes = []
  return {
    routes,
    get(path, ...handlers) {
      routes.push({ method: 'get', path, handlers })
    },
    post(path, ...handlers) {
      routes.push({ method: 'post', path, handlers })
    },
  }
}

async function loadRouter(settings) {
  vi.resetModules()
  vi.doMock('@overleaf/settings', () => ({ default: settings }))
  vi.doMock('@overleaf/fetch-utils', () => ({
    fetchStream: sinon.stub(),
    fetchNothing: sinon.stub(),
  }))
  vi.doMock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
    RateLimiter: class {
      constructor(name) {
        this.name = name
      }
    },
  }))
  vi.doMock(
    '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs',
    () => ({
      default: { rateLimit: () => function rateLimitMiddleware() {} },
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/History/HistoryManager.mjs',
    () => ({
      default: { promises: {} },
    })
  )
  vi.doMock('../../../../../app/src/Features/Project/SafePath.mjs', () => ({
    default: {},
  }))
  vi.doMock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
    default: { promises: {} },
  }))
  // project-sync's services reach Mongo through ProjectEntityHandler, while
  // the router only needs them as injected collaborators.
  const service = () => ({ default: { promises: {} } })
  vi.doMock('../../../../project-sync/app/src/ProjectRef.mjs', service)
  vi.doMock('../../../../project-sync/app/src/VersionService.mjs', service)
  vi.doMock('../../../../project-sync/app/src/SnapshotService.mjs', service)
  vi.doMock('../../../../project-sync/app/src/LabelService.mjs', service)
  vi.doMock('../../../../project-sync/app/src/WriteService.mjs', service)
  vi.doMock('../../../../project-sync/app/src/TokenAuthMiddleware.mjs', () => ({
    requireAccessToken: scope =>
      Object.assign(function authenticate() {}, { scope }),
    default: { requireAccessToken: () => function authenticate() {} },
  }))
  return await import('../../../app/src/GitBridgeRouter.mjs')
}

describe('GitBridgeRouter', () => {
  it('registers nothing when the feature is disabled', async () => {
    const { apply } = await loadRouter({ enableGitBridge: false })
    const publicApiRouter = fakeRouter()
    apply({}, {}, publicApiRouter)
    expect(publicApiRouter.routes).toEqual([])
  })

  it('registers the five git-bridge routes when enabled', async () => {
    const { apply } = await loadRouter({
      enableGitBridge: true,
      security: { sessionSecret: 's' },
      siteUrl: 'https://overleaf.example',
    })
    const publicApiRouter = fakeRouter()
    apply({}, {}, publicApiRouter)
    expect(
      publicApiRouter.routes.map(route => `${route.method} ${route.path}`)
    ).toEqual([
      'get /api/v0/docs/:projectId',
      'get /api/v0/docs/:projectId/saved_vers',
      'get /api/v0/docs/:projectId/snapshots/:version',
      'post /api/v0/docs/:projectId/snapshots',
      'get /api/v0/docs/:projectId/blobs/:hash',
    ])
  })

  it('leaves the blob route unauthenticated so git-bridge can fetch attachments', async () => {
    const { apply } = await loadRouter({
      enableGitBridge: true,
      security: { sessionSecret: 's' },
      siteUrl: 'https://overleaf.example',
    })
    const publicApiRouter = fakeRouter()
    apply({}, {}, publicApiRouter)
    const routes = publicApiRouter.routes
    const blob = routes[routes.length - 1]
    expect(blob.path).toEqual('/api/v0/docs/:projectId/blobs/:hash')
    expect(blob.handlers).toHaveLength(2)
    expect(blob.handlers.some(handler => handler.name === 'authenticate')).toBe(
      false
    )
    expect(routes[0].handlers[0].scope).toEqual('git_bridge')
  })
})
