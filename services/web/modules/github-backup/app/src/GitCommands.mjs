import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'

const execFileAsync = promisify(execFile)

const MAX_BUFFER_BYTES = 4 * 1024 * 1024

// git calls GIT_ASKPASS with the prompt as its first argument. Answering the
// username prompt from the same script keeps both halves of the credential out
// of argv and out of the remote URL.
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) printf %s "$OL_BACKUP_GIT_USERNAME" ;;',
  '  *) printf %s "$OL_BACKUP_GIT_PASSWORD" ;;',
  'esac',
  '',
].join('\n')

// Token shapes that must never reach a log line or a stored error message.
const SECRET_PATTERNS = [
  /olp_[A-Za-z0-9]+/g,
  /gh[pousr]_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  // Anything a URL carries as userinfo, whatever its shape.
  /(https?:\/\/)[^/@\s]+@/g,
]

const REDACTED = '[redacted]'

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove credentials from text before it is logged or persisted.
 *
 * @param {string} text
 * @param {string[]} [secrets] exact secret values used by this command
 * @return {string}
 */
function scrubSecrets(text, secrets = []) {
  let output = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    output = output.replace(
      new RegExp(escapeForRegExp(secret), 'g'),
      () => REDACTED
    )
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix) =>
      prefix ? `${prefix}${REDACTED}@` : REDACTED
    )
  }
  return output
}

async function makeCredentialDirectory() {
  const prefix = Path.join(os.tmpdir(), 'overleaf-github-backup-')
  const directory = await fs.mkdtemp(prefix)
  await fs.chmod(directory, 0o700)
  const askpass = Path.join(directory, 'askpass.sh')
  await fs.writeFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 })
  return { directory, askpass }
}

function baseEnvironment(homeDirectory) {
  return {
    PATH: process.env.PATH,
    LANG: 'C',
    LC_ALL: 'C',
    HOME: homeDirectory,
    // Never read the machine's git configuration, and never block on a prompt.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ADVICE: '0',
  }
}

class GitCommandError extends Error {
  constructor(message, { stderr, exitCode, timedOut }) {
    super(message)
    this.name = 'GitCommandError'
    this.stderr = stderr
    this.exitCode = exitCode
    this.timedOut = timedOut
  }
}

/**
 * Run one git command.
 *
 * @param {string[]} args
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {{username: string, password: string}} [options.credentials]
 * @return {Promise<{stdout: string, stderr: string}>}
 */
async function runGit(args, options = {}) {
  const { cwd, timeoutMs = 300000, credentials } = options
  const secrets = credentials?.password ? [credentials.password] : []
  let credentialDirectory = null
  let environment
  try {
    if (credentials) {
      const created = await makeCredentialDirectory()
      credentialDirectory = created.directory
      environment = {
        ...baseEnvironment(created.directory),
        GIT_ASKPASS: created.askpass,
        OL_BACKUP_GIT_USERNAME: credentials.username,
        OL_BACKUP_GIT_PASSWORD: credentials.password,
      }
    } else {
      environment = baseEnvironment(os.tmpdir())
    }
    const result = await execFileAsync('git', args, {
      cwd,
      env: environment,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    })
    return {
      stdout: String(result.stdout ?? ''),
      stderr: scrubSecrets(result.stderr ?? '', secrets),
    }
  } catch (error) {
    const stderr = scrubSecrets(error.stderr ?? error.message ?? '', secrets)
    throw new GitCommandError(scrubSecrets(`git ${args[0]} failed`, secrets), {
      stderr,
      exitCode: error.code,
      timedOut: error.killed === true || error.signal != null,
    })
  } finally {
    if (credentialDirectory) {
      await fs.rm(credentialDirectory, { recursive: true, force: true })
    }
  }
}

export { runGit, scrubSecrets, GitCommandError }
export default { runGit, scrubSecrets, GitCommandError }
