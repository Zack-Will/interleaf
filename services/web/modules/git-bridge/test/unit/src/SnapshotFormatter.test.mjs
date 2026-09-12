import { describe, it, expect } from 'vitest'
import { formatSnapshot } from '../../../app/src/SnapshotFormatter.mjs'

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'
const NOW = 1_700_000_000_000

const settings = {
  security: { sessionSecret: 'session-secret' },
  siteUrl: 'https://overleaf.example',
}

describe('SnapshotFormatter', () => {
  it('splits docs into srcs and binaries into signed atts', () => {
    const snapshot = {
      version: 7,
      files: [
        { path: '/main.tex', kind: 'doc', content: '\\documentclass{article}' },
        { path: 'figures/plot.png', kind: 'file', hash: 'b'.repeat(40) },
      ],
    }
    const { srcs, atts } = formatSnapshot(PROJECT_ID, snapshot, {
      settings,
      now: NOW,
    })
    expect(srcs).toEqual([['\\documentclass{article}', 'main.tex']])
    expect(atts).toHaveLength(1)
    const [url, path] = atts[0]
    expect(path).toEqual('figures/plot.png')
    const parsed = new URL(url)
    expect(parsed.pathname).toEqual(
      `/api/v0/docs/${PROJECT_ID}/blobs/${'b'.repeat(40)}`
    )
    expect(parsed.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.searchParams.get('_path')).toEqual('figures/plot.png')
  })

  it('returns empty lists for an empty project', () => {
    expect(formatSnapshot(PROJECT_ID, { files: [] }, { settings })).toEqual({
      srcs: [],
      atts: [],
    })
    expect(formatSnapshot(PROJECT_ID, undefined, { settings })).toEqual({
      srcs: [],
      atts: [],
    })
  })

  it('skips binaries that carry no hash', () => {
    const snapshot = { files: [{ path: 'broken.bin', kind: 'file' }] }
    expect(formatSnapshot(PROJECT_ID, snapshot, { settings }).atts).toEqual([])
  })
})
