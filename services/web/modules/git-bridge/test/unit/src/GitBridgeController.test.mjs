import { Readable, Writable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import sinon from 'sinon'
import { createHandlers } from '../../../app/src/GitBridgeController.mjs'
import { buildSignedBlobUrl } from '../../../app/src/SignedBlobUrl.mjs'

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'
const USER_ID = '5f6e7b868c1f9a3e4b0c2d1a'
const HASH = 'c'.repeat(40)

const settings = {
  security: { sessionSecret: 'session-secret' },
  siteUrl: 'https://overleaf.example',
}

// A writable stand-in for the express response, so that stream.pipeline works
// for the blob route while res.json() keeps working for the JSON routes.
class FakeRes extends Writable {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.chunks = []
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  status(code) {
    this.statusCode = code
    return this
  }

  json(body) {
    this.body = body
    return this
  }

  setHeader(name, value) {
    this.headers[name] = value
  }
}

function fakeRes() {
  return new FakeRes()
}

function fakeReq(overrides = {}) {
  return {
    params: { projectId: PROJECT_ID },
    query: {},
    body: {},
    syncUser: { userId: USER_ID, scopes: ['git_bridge'], tokenId: 't' },
    ...overrides,
  }
}

function buildServices(overrides = {}) {
  return {
    settings,
    logger: { error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() },
    ProjectRef: { requireAccess: sinon.stub().resolves(true) },
    VersionService: {
      promises: {
        getLatestVersion: sinon.stub().resolves({
          version: 11,
          timestamp: '2026-03-01T12:00:00.000Z',
          v2Authors: [USER_ID],
        }),
      },
    },
    SnapshotService: {
      promises: { getSnapshot: sinon.stub().resolves({ files: [] }) },
    },
    LabelService: { promises: { listLabels: sinon.stub().resolves([]) } },
    UserGetter: {
      promises: {
        getUser: sinon.stub().resolves({
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@x',
        }),
      },
    },
    HistoryManager: { promises: { requestBlobWithProjectId: sinon.stub() } },
    runPushJob: sinon.stub().resolves({}),
    ...overrides,
  }
}

function accessError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

describe('GitBridgeController GET /docs/:projectId', () => {
  it('returns the latest version, timestamp and author', async () => {
    const services = buildServices()
    const res = fakeRes()
    await createHandlers(services).getDoc(fakeReq(), res)
    expect(res.body).toEqual({
      latestVerId: 11,
      latestVerBy: { name: 'Ada Lovelace', email: 'ada@x' },
      latestVerAt: '2026-03-01T12:00:00.000Z',
    })
  })

  it('reports latestVerId 0 and omits latestVerAt for an empty project', async () => {
    const services = buildServices({
      VersionService: {
        promises: { getLatestVersion: sinon.stub().resolves({ version: 0 }) },
      },
    })
    const res = fakeRes()
    await createHandlers(services).getDoc(fakeReq(), res)
    expect(res.body).toEqual({
      latestVerId: 0,
      latestVerBy: { name: 'Unknown', email: '' },
    })
    expect('latestVerAt' in res.body).toBe(false)
  })

  it('answers 403 without read access and 404 for a missing project', async () => {
    const forbidden = buildServices({
      ProjectRef: {
        requireAccess: sinon.stub().rejects(accessError('forbidden')),
      },
    })
    const forbiddenRes = fakeRes()
    await createHandlers(forbidden).getDoc(fakeReq(), forbiddenRes)
    expect(forbiddenRes.statusCode).toEqual(403)
    expect(forbiddenRes.body).toEqual({ status: 403, message: 'Forbidden' })

    const missing = buildServices({
      ProjectRef: {
        requireAccess: sinon.stub().rejects(accessError('not_found')),
      },
    })
    const missingRes = fakeRes()
    await createHandlers(missing).getDoc(fakeReq(), missingRes)
    expect(missingRes.statusCode).toEqual(404)
    expect(missingRes.body).toEqual({ status: 404, message: 'Not Found' })
  })

  it('answers 404 for a project id that is not 24 hex characters', async () => {
    const services = buildServices()
    const res = fakeRes()
    await createHandlers(services).getDoc(
      fakeReq({ params: { projectId: 'nope' } }),
      res
    )
    expect(res.statusCode).toEqual(404)
    expect(services.ProjectRef.requireAccess.called).toBe(false)
  })
})

describe('GitBridgeController GET /docs/:projectId/saved_vers', () => {
  it('maps project-history labels onto the git-bridge shape', async () => {
    const services = buildServices({
      LabelService: {
        promises: {
          listLabels: sinon.stub().resolves([
            {
              id: 'l1',
              comment: 'Update from Git',
              version: 9,
              user_id: USER_ID,
              created_at: '2026-02-01T09:30:00.000Z',
            },
          ]),
        },
      },
    })
    const res = fakeRes()
    await createHandlers(services).getSavedVers(fakeReq(), res)
    expect(res.body).toEqual([
      {
        versionId: 9,
        comment: 'Update from Git',
        user: { name: 'Ada Lovelace', email: 'ada@x' },
        createdAt: '2026-02-01T09:30:00.000Z',
      },
    ])
  })

  it('returns a bare empty array when there are no labels', async () => {
    const res = fakeRes()
    await createHandlers(buildServices()).getSavedVers(fakeReq(), res)
    expect(res.body).toEqual([])
  })
})

describe('GitBridgeController GET /docs/:projectId/snapshots/:version', () => {
  it('returns srcs and atts for the requested version', async () => {
    const services = buildServices({
      SnapshotService: {
        promises: {
          getSnapshot: sinon.stub().resolves({
            files: [
              { path: 'main.tex', kind: 'doc', content: 'hello' },
              { path: 'logo.png', kind: 'file', hash: HASH },
            ],
          }),
        },
      },
    })
    const res = fakeRes()
    await createHandlers(services).getSnapshot(
      fakeReq({ params: { projectId: PROJECT_ID, version: '7' } }),
      res
    )
    expect(
      services.SnapshotService.promises.getSnapshot.calledWith(PROJECT_ID, 7, {
        includeBinary: true,
      })
    ).toBe(true)
    expect(res.body.srcs).toEqual([['hello', 'main.tex']])
    expect(res.body.atts).toHaveLength(1)
    expect(res.body.atts[0][1]).toEqual('logo.png')
    expect(res.body.atts[0][0]).toContain(`/blobs/${HASH}?token=`)
  })

  it('answers 404 for a non numeric version', async () => {
    const res = fakeRes()
    await createHandlers(buildServices()).getSnapshot(
      fakeReq({ params: { projectId: PROJECT_ID, version: 'head' } }),
      res
    )
    expect(res.statusCode).toEqual(404)
  })
})

describe('GitBridgeController POST /docs/:projectId/snapshots', () => {
  const pushBody = {
    latestVerId: 11,
    files: [{ name: 'main.tex', url: 'http://git-bridge:8000/api/p/u?key=k' }],
    postbackUrl: 'http://git-bridge:8000/api/p/k/postback',
  }

  it('accepts a push on the current version and starts the job', async () => {
    const services = buildServices()
    const res = fakeRes()
    await createHandlers(services).postSnapshot(
      fakeReq({ body: pushBody }),
      res
    )
    expect(res.statusCode).toEqual(200)
    expect(res.body).toEqual({
      status: 402,
      code: 'accepted',
      message: 'Accepted',
    })
    expect(services.runPushJob.firstCall.args[0]).toEqual({
      projectId: PROJECT_ID,
      userId: USER_ID,
      latestVerId: 11,
      files: pushBody.files,
      postbackUrl: pushBody.postbackUrl,
    })
  })

  it('rejects a stale push with HTTP 200 and an outOfDate body', async () => {
    const services = buildServices()
    const res = fakeRes()
    await createHandlers(services).postSnapshot(
      fakeReq({ body: { ...pushBody, latestVerId: 9 } }),
      res
    )
    expect(res.statusCode).toEqual(200)
    expect(res.body).toEqual({
      status: 409,
      code: 'outOfDate',
      message: 'Out of Date',
    })
    expect(services.runPushJob.called).toBe(false)
  })

  it('answers 403 without write access', async () => {
    const services = buildServices({
      ProjectRef: {
        requireAccess: sinon.stub().rejects(accessError('forbidden')),
      },
    })
    const res = fakeRes()
    await createHandlers(services).postSnapshot(
      fakeReq({ body: pushBody }),
      res
    )
    expect(res.statusCode).toEqual(403)
    expect(services.runPushJob.called).toBe(false)
  })

  it('checks write access rather than read access', async () => {
    const services = buildServices()
    const res = fakeRes()
    await createHandlers(services).postSnapshot(
      fakeReq({ body: pushBody }),
      res
    )
    expect(services.ProjectRef.requireAccess.firstCall.args).toEqual([
      USER_ID,
      PROJECT_ID,
      'write',
    ])
  })
})

describe('GitBridgeController GET /docs/:projectId/blobs/:hash', () => {
  function signedQuery(now) {
    const url = new URL(
      buildSignedBlobUrl(PROJECT_ID, HASH, 'logo.png', { settings, now })
    )
    return Object.fromEntries(url.searchParams.entries())
  }

  it('streams the blob when the signature is valid', async () => {
    const services = buildServices({
      HistoryManager: {
        promises: {
          requestBlobWithProjectId: sinon.stub().resolves({
            stream: Readable.from([Buffer.from('png-bytes')]),
            contentLength: 9,
          }),
        },
      },
    })
    const res = fakeRes()
    await createHandlers(services).getBlob(
      fakeReq({
        params: { projectId: PROJECT_ID, hash: HASH },
        query: signedQuery(Date.now()),
      }),
      res
    )
    expect(res.headers['Content-Type']).toEqual('application/octet-stream')
    expect(res.headers['Content-Length']).toEqual('9')
    expect(Buffer.concat(res.chunks).toString()).toEqual('png-bytes')
  })

  it('answers 403 for a missing or expired signature', async () => {
    const services = buildServices()
    const unsigned = fakeRes()
    await createHandlers(services).getBlob(
      fakeReq({ params: { projectId: PROJECT_ID, hash: HASH } }),
      unsigned
    )
    expect(unsigned.statusCode).toEqual(403)

    const expired = fakeRes()
    await createHandlers(services).getBlob(
      fakeReq({
        params: { projectId: PROJECT_ID, hash: HASH },
        query: signedQuery(Date.now() - 11 * 60 * 1000),
      }),
      expired
    )
    expect(expired.statusCode).toEqual(403)
    expect(
      services.HistoryManager.promises.requestBlobWithProjectId.called
    ).toBe(false)
  })

  it('answers 404 when history has no such blob', async () => {
    const services = buildServices({
      HistoryManager: {
        promises: {
          requestBlobWithProjectId: sinon.stub().rejects(new Error('404')),
        },
      },
    })
    const res = fakeRes()
    await createHandlers(services).getBlob(
      fakeReq({
        params: { projectId: PROJECT_ID, hash: HASH },
        query: signedQuery(Date.now()),
      }),
      res
    )
    expect(res.statusCode).toEqual(404)
  })
})
