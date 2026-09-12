import { describe, it, expect } from 'vitest'
import {
  buildSignedBlobUrl,
  verifyBlobToken,
} from '../../../app/src/SignedBlobUrl.mjs'

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'
const HASH = 'a'.repeat(40)
const NOW = 1_700_000_000_000

const settings = {
  security: { sessionSecret: 'session-secret' },
  siteUrl: 'https://overleaf.example',
}

function parse(url) {
  const parsed = new URL(url)
  return {
    pathname: parsed.pathname,
    token: parsed.searchParams.get('token'),
    exp: parsed.searchParams.get('exp'),
    path: parsed.searchParams.get('_path'),
  }
}

describe('SignedBlobUrl', () => {
  it('builds an absolute self-authenticating URL', () => {
    const url = buildSignedBlobUrl(PROJECT_ID, HASH, 'figures/plot.png', {
      settings,
      now: NOW,
    })
    const parsed = parse(url)
    expect(url.startsWith('https://overleaf.example/api/v0/docs/')).toBe(true)
    expect(parsed.pathname).toEqual(`/api/v0/docs/${PROJECT_ID}/blobs/${HASH}`)
    expect(parsed.token).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.exp).toEqual(String(NOW / 1000 + 600))
    expect(parsed.path).toEqual('figures/plot.png')
  })

  it('prefers the git-bridge specific base URL and secret', () => {
    const url = buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', {
      settings: {
        ...settings,
        gitBridge: { blobUrlSecret: 'other-secret' },
        apis: { gitBridge: { webPublicUrl: 'http://web:3000/' } },
      },
      now: NOW,
    })
    expect(url.startsWith('http://web:3000/api/v0/docs/')).toBe(true)
    expect(parse(url).token).not.toEqual(
      parse(
        buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', { settings, now: NOW })
      ).token
    )
  })

  it('verifies a freshly signed token', () => {
    const query = parse(
      buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', { settings, now: NOW })
    )
    expect(
      verifyBlobToken(PROJECT_ID, HASH, query, { settings, now: NOW })
    ).toBe(true)
  })

  it('rejects an expired token', () => {
    const query = parse(
      buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', { settings, now: NOW })
    )
    const later = NOW + 10 * 60 * 1000 + 1000
    expect(
      verifyBlobToken(PROJECT_ID, HASH, query, { settings, now: later })
    ).toBe(false)
  })

  it('rejects a token signed for another project or hash', () => {
    const query = parse(
      buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', { settings, now: NOW })
    )
    const other = '68c1f9a3e4b0c2d1a5f6e7b9'
    expect(verifyBlobToken(other, HASH, query, { settings, now: NOW })).toBe(
      false
    )
    expect(
      verifyBlobToken(PROJECT_ID, 'b'.repeat(40), query, {
        settings,
        now: NOW,
      })
    ).toBe(false)
  })

  it('rejects a tampered expiry and a missing token', () => {
    const query = parse(
      buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', { settings, now: NOW })
    )
    expect(
      verifyBlobToken(
        PROJECT_ID,
        HASH,
        { ...query, exp: String(Number(query.exp) + 3600) },
        { settings, now: NOW }
      )
    ).toBe(false)
    expect(
      verifyBlobToken(
        PROJECT_ID,
        HASH,
        { exp: query.exp },
        {
          settings,
          now: NOW,
        }
      )
    ).toBe(false)
    expect(
      verifyBlobToken(
        PROJECT_ID,
        HASH,
        { token: 'deadbeef' },
        {
          settings,
          now: NOW,
        }
      )
    ).toBe(false)
  })

  it('refuses to sign without a configured secret', () => {
    expect(() =>
      buildSignedBlobUrl(PROJECT_ID, HASH, 'a.png', {
        settings: { siteUrl: 'https://overleaf.example', security: {} },
        now: NOW,
      })
    ).toThrow(/secret/)
  })
})
