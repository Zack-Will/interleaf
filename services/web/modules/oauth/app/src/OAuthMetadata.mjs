// Discovery documents for MCP clients: protected resource metadata (RFC 9728)
// for /mcp and authorization server metadata (RFC 8414). The issuer is the
// site URL; there is no dynamic client registration.

export const SCOPE = 'mcp'

export function issuer(siteUrl) {
  return String(siteUrl).replace(/\/+$/, '')
}

export function resourceUrl(siteUrl) {
  return `${issuer(siteUrl)}/mcp`
}

export function protectedResourceMetadata(siteUrl) {
  return {
    resource: resourceUrl(siteUrl),
    authorization_servers: [issuer(siteUrl)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Overleaf MCP',
  }
}

export function authorizationServerMetadata(siteUrl) {
  const base = issuer(siteUrl)
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
    ],
    revocation_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
    ],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  }
}

export default {
  SCOPE,
  issuer,
  resourceUrl,
  protectedResourceMetadata,
  authorizationServerMetadata,
}
