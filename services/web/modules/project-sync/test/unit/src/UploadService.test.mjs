import { beforeEach, describe, expect, it, vi } from 'vitest'

function fakeRedis() {
  const values = new Map()
  return {
    values,
    async get(key) {
      return values.get(key) ?? null
    },
    async set(key, value, _ex, _ttl, mode) {
      if (mode === 'NX' && values.has(key)) return null
      values.set(key, value)
      return 'OK'
    },
    async del(key) {
      values.delete(key)
    },
  }
}

const request = {
  projectId: 'p',
  userId: 'u',
  tokenId: 't',
  message: 'add figures',
  agent: 'claude',
}

// .rejects does not work under this repository's test setup.
const failureOf = promise => promise.catch(error => error)

describe('UploadService', () => {
  let UploadService
  let redis

  beforeEach(async () => {
    vi.resetModules()
    redis = fakeRedis()
    vi.doMock('@overleaf/settings', () => ({
      default: { siteUrl: 'https://example.test', maxUploadSize: 100 },
    }))
    vi.doMock('../../../../../app/src/infrastructure/RedisWrapper.mjs', () => ({
      default: { client: () => redis },
    }))
    ;({ default: UploadService } =
      await import('../../../app/src/UploadService.mjs'))
  })

  it('issues one ticket per path and keeps only hashes in redis', async () => {
    const created = await UploadService.createTickets({
      ...request,
      paths: ['figures/a.pdf', '/b.png'],
    })
    expect(created.uploads.map(upload => upload.path)).toEqual([
      'figures/a.pdf',
      'b.png',
    ])
    expect(created.upload_url).toBe('https://example.test/mcp/uploads')
    expect(created.max_bytes).toBe(100)
    const keys = [...redis.values.keys()].join(' ')
    for (const upload of created.uploads) {
      expect(upload.ticket).toMatch(/^olu_[A-Za-z0-9_-]{32}$/)
      expect(keys).not.toContain(upload.ticket)
    }
  })

  it.each([
    ['a parent segment', '../secret.pdf'],
    ['a nested parent segment', 'figures/../../secret.pdf'],
    ['a current segment', './a.pdf'],
    ['a double slash', 'figures//a.pdf'],
    ['a trailing slash', 'figures/'],
    ['an empty path', ''],
    ['a backslash', 'figures\\a.pdf'],
  ])('refuses %s', async (_name, path) => {
    expect(
      await failureOf(
        UploadService.createTickets({ ...request, paths: [path] })
      )
    ).toMatchObject({ code: 'invalid_path' })
    expect(redis.values.size).toBe(0)
  })

  it('refuses the same path twice', async () => {
    expect(
      await failureOf(
        UploadService.createTickets({ ...request, paths: ['a.pdf', '/a.pdf'] })
      )
    ).toMatchObject({ code: 'invalid_path' })
  })

  it('returns the record to the first claim and refuses a second', async () => {
    const { uploads } = await UploadService.createTickets({
      ...request,
      paths: ['a.pdf'],
      overwrite: true,
    })
    const { ticket } = uploads[0]
    expect(await UploadService.claim(ticket)).toMatchObject({
      projectId: 'p',
      userId: 'u',
      tokenId: 't',
      path: 'a.pdf',
      overwrite: true,
    })
    expect(await failureOf(UploadService.claim(ticket))).toMatchObject({
      code: 'upload_in_progress',
    })
  })

  it('lets a released ticket be claimed again', async () => {
    const { uploads } = await UploadService.createTickets({
      ...request,
      paths: ['a.pdf'],
    })
    const { ticket } = uploads[0]
    await UploadService.claim(ticket)
    await UploadService.release(ticket)
    expect(await UploadService.claim(ticket)).toMatchObject({ path: 'a.pdf' })
  })

  it('refuses a consumed ticket', async () => {
    const { uploads } = await UploadService.createTickets({
      ...request,
      paths: ['a.pdf'],
    })
    const { ticket } = uploads[0]
    await UploadService.claim(ticket)
    await UploadService.consume(ticket)
    expect(redis.values.size).toBe(0)
    expect(await failureOf(UploadService.claim(ticket))).toMatchObject({
      code: 'upload_ticket_invalid',
    })
  })

  it.each([[null], ['olp_abcdefghijklmnop'], ['olu_short']])(
    'refuses the malformed ticket %s',
    async ticket => {
      expect(await failureOf(UploadService.claim(ticket))).toMatchObject({
        code: 'upload_ticket_invalid',
      })
    }
  )
})
