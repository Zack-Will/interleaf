import Settings from '@overleaf/settings'
import AccessTokenEncryptor from '@overleaf/access-token-encryptor'
import { BackupDisabledError } from './Errors.mjs'

let encryptor = null

// Built lazily: a server with the feature turned off has no cipher password and
// must still be able to import this module.
function getEncryptor() {
  if (encryptor) return encryptor
  const config = Settings.githubBackup?.accessTokenEncryptor
  if (!config?.cipherLabel || !config?.cipherPasswords) {
    throw new BackupDisabledError(
      'GITHUB_BACKUP_CIPHER_PASSWORD is not configured, so backup tokens cannot be stored'
    )
  }
  encryptor = new AccessTokenEncryptor(config)
  return encryptor
}

async function encryptToken(token) {
  return await getEncryptor().promises.encryptJson({ token })
}

async function decryptToken(encrypted) {
  const payload = await getEncryptor().promises.decryptToJson(encrypted)
  return payload.token
}

// Only used by the unit tests, which build a fresh encryptor per settings stub.
function resetForTesting() {
  encryptor = null
}

export { encryptToken, decryptToken, resetForTesting }
export default { encryptToken, decryptToken, resetForTesting }
