import Settings from '@overleaf/settings'
import {
  GithubApiError,
  GithubAuthFailedError,
  GithubRepoNotFoundError,
  InvalidRepositoryError,
} from './Errors.mjs'

const API_VERSION = '2022-11-28'
const USER_AGENT = 'overleaf-github-backup'
const REQUEST_TIMEOUT_MS = 30000

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function apiBaseUrl() {
  return String(
    Settings.githubBackup?.apiBaseUrl || 'https://api.github.com'
  ).replace(/\/+$/, '')
}

function assertName(value) {
  if (!NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new InvalidRepositoryError()
  }
  return value
}

/**
 * Accept `owner/repo`, `https://github.com/owner/repo`, the same with `.git`
 * or a trailing slash, and `git@github.com:owner/repo.git`.
 *
 * @param {string} input
 * @return {{owner: string, repo: string}}
 */
function parseRepository(input) {
  if (typeof input !== 'string') throw new InvalidRepositoryError()
  let value = input.trim()
  if (!value) throw new InvalidRepositoryError()
  value = value.replace(/^git@github\.com:/i, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url
    try {
      url = new URL(value)
    } catch {
      throw new InvalidRepositoryError()
    }
    value = url.pathname
  }
  value = value.replace(/^\/+/, '').replace(/\/+$/, '')
  value = value.replace(/\.git$/i, '')
  const parts = value.split('/')
  if (parts.length !== 2) throw new InvalidRepositoryError()
  return { owner: assertName(parts[0]), repo: assertName(parts[1]) }
}

function repoUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}`
}

function cloneUrl(owner, repo) {
  return `${repoUrl(owner, repo)}.git`
}

function errorFromStatus(status, path, body) {
  const detail = body?.message ? `: ${body.message}` : ''
  if (status === 401) {
    return new GithubAuthFailedError(
      `GitHub rejected the access token${detail}`
    )
  }
  if (status === 403) {
    return new GithubAuthFailedError(
      `GitHub refused the request with the supplied token${detail}`
    )
  }
  if (status === 404) {
    return new GithubRepoNotFoundError(`GitHub returned 404 for ${path}`)
  }
  return new GithubApiError(`GitHub returned ${status} for ${path}${detail}`, {
    status,
  })
}

/**
 * One GitHub REST call. The token only ever travels in the Authorization
 * header, never in the URL.
 */
async function request(path, { token, method = 'GET', body } = {}) {
  const url = `${apiBaseUrl()}${path}`
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  }
  if (body) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new GithubApiError('could not reach the GitHub API', {
      cause: error,
    })
  }
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) throw errorFromStatus(response.status, path, payload)
  return payload
}

/**
 * @return {Promise<{owner: string, repo: string, defaultBranch: string, private: boolean, canPush: boolean}>}
 */
async function getRepository(owner, repo, token) {
  const data = await request(`/repos/${owner}/${repo}`, { token })
  return describeRepository(data, owner, repo)
}

async function createRepository(owner, repo, token) {
  const data = await request('/user/repos', {
    token,
    method: 'POST',
    body: { name: repo, private: true, auto_init: false },
  })
  return describeRepository(data, owner, repo)
}

function describeRepository(data, owner, repo) {
  return {
    owner: data?.owner?.login || owner,
    repo: data?.name || repo,
    defaultBranch: data?.default_branch || null,
    private: Boolean(data?.private),
    canPush: Boolean(data?.permissions?.push),
  }
}

export {
  parseRepository,
  repoUrl,
  cloneUrl,
  getRepository,
  createRepository,
  request,
}

export default {
  parseRepository,
  repoUrl,
  cloneUrl,
  getRepository,
  createRepository,
  request,
}
