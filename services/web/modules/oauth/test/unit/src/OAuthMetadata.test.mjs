import { describe, expect, it } from 'vitest'
// eslint-disable-next-line import/no-unresolved -- subpath export
import * as SdkAuth from '@modelcontextprotocol/sdk/shared/auth.js'
import OAuthMetadata from '../../../app/src/OAuthMetadata.mjs'

describe('oauth OAuthMetadata', () => {
  it('describes /mcp as a protected resource (RFC 9728)', () => {
    const document = OAuthMetadata.protectedResourceMetadata(
      'https://overleaf.example/'
    )
    expect(document).toMatchObject({
      resource: 'https://overleaf.example/mcp',
      authorization_servers: ['https://overleaf.example'],
      scopes_supported: ['mcp'],
    })
    expect(() =>
      SdkAuth.OAuthProtectedResourceMetadataSchema.parse(document)
    ).not.toThrow()
  })

  it('describes the authorization server without registration (RFC 8414)', () => {
    const document = OAuthMetadata.authorizationServerMetadata(
      'https://overleaf.example'
    )
    expect(document).toMatchObject({
      issuer: 'https://overleaf.example',
      authorization_endpoint: 'https://overleaf.example/oauth/authorize',
      token_endpoint: 'https://overleaf.example/oauth/token',
      revocation_endpoint: 'https://overleaf.example/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
      ],
      scopes_supported: ['mcp'],
    })
    expect(document).not.toHaveProperty('registration_endpoint')
    expect(() => SdkAuth.OAuthMetadataSchema.parse(document)).not.toThrow()
  })
})
