import OError from '@overleaf/o-error'

// Every error carries a stable `code`. `GithubBackupRouter` maps the code to an
// HTTP status and the MCP tools hand the code straight to the agent, so the
// codes are part of the module's public contract.

class BackupDisabledError extends OError {
  constructor(message = 'GitHub backup is not enabled on this server') {
    super(message)
    this.code = 'backup_disabled'
  }
}

class BackupNotLinkedError extends OError {
  constructor(message = 'this project is not linked to a GitHub repository') {
    super(message)
    this.code = 'backup_not_linked'
  }
}

class InvalidRepositoryError extends OError {
  constructor(
    message = 'expected a GitHub repository as "owner/repo" or as an https://github.com/owner/repo URL'
  ) {
    super(message)
    this.code = 'invalid_repository'
  }
}

class InvalidBackupRequestError extends OError {
  constructor(message = 'invalid GitHub backup request') {
    super(message)
    this.code = 'invalid_request'
  }
}

class GithubAuthFailedError extends OError {
  constructor(message = 'GitHub rejected the access token') {
    super(message)
    this.code = 'github_auth_failed'
  }
}

class GithubRepoNotFoundError extends OError {
  constructor(message = 'GitHub repository not found') {
    super(message)
    this.code = 'github_repo_not_found'
  }
}

class GithubNoPushPermissionError extends OError {
  constructor(
    message = 'the GitHub token cannot push to this repository; it needs "Contents: read and write"'
  ) {
    super(message)
    this.code = 'github_no_push_permission'
  }
}

class GithubApiError extends OError {
  constructor(message = 'the GitHub API call failed', properties = {}) {
    super(message, properties)
    this.code = 'github_api_error'
    this.status = properties.status
  }
}

export {
  BackupDisabledError,
  BackupNotLinkedError,
  InvalidRepositoryError,
  InvalidBackupRequestError,
  GithubAuthFailedError,
  GithubRepoNotFoundError,
  GithubNoPushPermissionError,
  GithubApiError,
}

export default {
  BackupDisabledError,
  BackupNotLinkedError,
  InvalidRepositoryError,
  InvalidBackupRequestError,
  GithubAuthFailedError,
  GithubRepoNotFoundError,
  GithubNoPushPermissionError,
  GithubApiError,
}
