import os from 'node:os'
import { Readable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import sinon from 'sinon'
import SafePath from '../../../../../app/src/Features/Project/SafePath.mjs'
import { createPushJob } from '../../../app/src/PushJob.mjs'

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'
const USER_ID = '5f6e7b868c1f9a3e4b0c2d1a'
const POSTBACK_URL =
  'http://git-bridge:8000/api/' + PROJECT_ID + '/key/postback'

function buildServices(overrides = {}) {
  const posted = []
  const services = {
    SafePath,
    settings: { path: { dumpFolder: os.tmpdir() } },
    logger: { error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() },
    fetchStream: sinon
      .stub()
      .callsFake(async url => Readable.from([Buffer.from(`body of ${url}`)])),
    fetchNothing: sinon.stub().callsFake(async (url, opts) => {
      posted.push({ url, body: opts.json })
    }),
    SnapshotService: {
      promises: {
        getFileTree: sinon.stub().resolves([
          { path: 'main.tex', kind: 'doc' },
          { path: 'gone.tex', kind: 'doc' },
        ]),
      },
    },
    WriteService: {
      promises: { writeFiles: sinon.stub().resolves({ version: 12 }) },
    },
    ...overrides,
  }
  return { services, posted }
}

function job(files) {
  return {
    projectId: PROJECT_ID,
    userId: USER_ID,
    latestVerId: 11,
    files,
    postbackUrl: POSTBACK_URL,
  }
}

describe('PushJob', () => {
  it('downloads changed files, derives deletes and posts upToDate', async () => {
    const { services, posted } = buildServices()
    const runPushJob = createPushJob(services)
    await runPushJob(
      job([
        { name: 'main.tex', url: 'http://git-bridge:8000/api/p/uuid?key=k' },
        { name: 'untouched.tex' },
      ])
    )

    expect(services.fetchStream.callCount).toEqual(1)
    const [projectId, userId, options] =
      services.WriteService.promises.writeFiles.firstCall.args
    expect(projectId).toEqual(PROJECT_ID)
    expect(userId).toEqual(USER_ID)
    expect(options.baseVersion).toEqual(11)
    expect(options.originKind).toEqual('git-bridge')
    expect(options.message).toEqual('Update from Git')
    expect(options.files).toEqual([
      {
        path: 'main.tex',
        contentBase64: Buffer.from(
          'body of http://git-bridge:8000/api/p/uuid?key=k'
        ).toString('base64'),
      },
      { path: 'gone.tex', delete: true },
    ])
    expect(posted).toEqual([
      { url: POSTBACK_URL, body: { code: 'upToDate', latestVerId: 12 } },
    ])
  })

  it('deletes nothing when every tree path is still present', async () => {
    const { services } = buildServices()
    const runPushJob = createPushJob(services)
    await runPushJob(job([{ name: 'main.tex' }, { name: 'gone.tex' }]))
    const [, , options] =
      services.WriteService.promises.writeFiles.firstCall.args
    expect(options.files).toEqual([])
  })

  it('posts invalidFiles with a suggestion for an unclean name', async () => {
    const { services, posted } = buildServices()
    const runPushJob = createPushJob(services)
    await runPushJob(
      job([{ name: 'bad*name.tex', url: 'http://git-bridge:8000/a' }])
    )
    expect(services.fetchStream.called).toBe(false)
    expect(services.WriteService.promises.writeFiles.called).toBe(false)
    expect(posted).toEqual([
      {
        url: POSTBACK_URL,
        body: {
          code: 'invalidFiles',
          errors: [
            {
              file: 'bad*name.tex',
              state: 'unclean_name',
              cleanFile: 'bad_name.tex',
            },
          ],
        },
      },
    ])
  })

  it('posts outOfDate when the write hits a version conflict', async () => {
    const conflict = new Error('project version conflict')
    conflict.code = 'version_conflict'
    const { services, posted } = buildServices({
      WriteService: {
        promises: { writeFiles: sinon.stub().rejects(conflict) },
      },
    })
    const runPushJob = createPushJob(services)
    await runPushJob(job([{ name: 'main.tex' }]))
    expect(posted).toEqual([
      {
        url: POSTBACK_URL,
        body: { code: 'outOfDate', message: 'Out of Date' },
      },
    ])
  })

  it('posts a generic error when the write blows up', async () => {
    const { services, posted } = buildServices({
      WriteService: {
        promises: { writeFiles: sinon.stub().rejects(new Error('boom')) },
      },
    })
    const runPushJob = createPushJob(services)
    await runPushJob(job([{ name: 'main.tex' }]))
    expect(posted).toEqual([
      { url: POSTBACK_URL, body: { code: 'error', message: 'boom' } },
    ])
  })

  it('reports per-file failures returned by the write service', async () => {
    const { services, posted } = buildServices({
      WriteService: {
        promises: {
          writeFiles: sinon.stub().resolves({
            version: 12,
            failed: [{ path: 'main.tex', error: 'nope' }],
          }),
        },
      },
    })
    const runPushJob = createPushJob(services)
    await runPushJob(job([{ name: 'main.tex' }]))
    expect(posted).toEqual([
      {
        url: POSTBACK_URL,
        body: {
          code: 'invalidFiles',
          errors: [{ file: 'main.tex', state: 'error' }],
        },
      },
    ])
  })

  it('swallows a failing postback', async () => {
    const { services } = buildServices({
      fetchNothing: sinon.stub().rejects(new Error('git-bridge is gone')),
    })
    const runPushJob = createPushJob(services)
    const result = await runPushJob(job([{ name: 'main.tex' }]))
    expect(result).toEqual({ code: 'upToDate', latestVerId: 12 })
    expect(services.logger.error.called).toBe(true)
  })
})
