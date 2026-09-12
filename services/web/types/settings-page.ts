export type AccessTokenScope = 'git_bridge' | 'mcp'

// Shape of the records returned by the `listPersonalAccessTokens` module hook
// (modules/project-sync/app/src/TokenService.mjs).
export type AccessToken = {
  id: string
  tokenPrefix: string
  scopes: AccessTokenScope[]
  label?: string
  createdAt: string
  expiresAt?: string | null
  lastUsedAt?: string | null
}

export type SAMLError = {
  translatedMessage?: string
  message?: string
  tryAgain?: boolean
  name?: string
}

export type InstitutionLink = {
  universityName: string
  hasEntitlement?: boolean
}
