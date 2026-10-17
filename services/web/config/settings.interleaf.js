// Interleaf settings: this fork's web modules, the frontend slots they fill and
// their configuration. settings.defaults.js calls `apply` once at load time, so
// the upstream defaults stay as shipped and an upstream merge only has to keep
// that one call. server-ce/config/settings.js overrides a few of these values
// for the Community Edition image; everything else is read from the
// environment here.

const Path = require('node:path')

const minutes = 60 * 1000

// Same semantics as intFromEnv in settings.defaults.js.
function intFromEnv(name, defaultValue) {
  return parseInt(process.env[name], 10) || defaultValue
}

function moduleFile(relativePath) {
  return Path.resolve(__dirname, '../modules', relativePath)
}

const MODULES = [
  'project-sync',
  'mcp',
  'git-bridge',
  'review',
  'github-backup',
  'live-preview',
]

// Frontend slots read by importOverleafModules(). compileDropdownItems is a slot
// this fork added to the compile button, the others exist upstream.
const MODULE_IMPORTS = {
  compileDropdownItems: ['live-preview/frontend/js/compile-dropdown-item.tsx'],
  sourceEditorExtensions: [
    'live-preview/frontend/js/source-editor-extension.ts',
  ],
  pdfLogEntriesComponents: ['live-preview/frontend/js/live-preview-logs.tsx'],
  pdfPreviewPromotions: ['live-preview/frontend/js/live-preview-overlay.tsx'],
  rootContextProviders: ['live-preview/frontend/js/live-preview-provider.tsx'],
  integrationLinkingWidgets: [
    'project-sync/frontend/js/components/personal-access-tokens-widget.tsx',
  ],
  integrationPanelComponents: [
    'git-bridge/frontend/js/components/git-and-agents-card.tsx',
    'github-backup/frontend/js/components/github-backup-card.tsx',
  ],
}

function appendAll(target, key, values) {
  target[key] = [...(target[key] || []), ...values]
}

function apply(settings) {
  settings.moduleImportSequence = [
    ...settings.moduleImportSequence,
    ...MODULES.filter(name => !settings.moduleImportSequence.includes(name)),
  ]
  for (const [slot, files] of Object.entries(MODULE_IMPORTS)) {
    appendAll(settings.overleafModuleImports, slot, files.map(moduleFile))
  }

  settings.apis.gitBridge = {
    url: `http://${process.env.GIT_BRIDGE_HOST || 'git-bridge'}:${
      process.env.GIT_BRIDGE_PORT || '8000'
    }`,
    // Absolute base URL that the git-bridge container uses to reach web, for
    // the self-authenticating blob URLs handed out in snapshots.
    webPublicUrl: process.env.GIT_BRIDGE_WEB_PUBLIC_URL,
  }

  Object.assign(settings, {
    enableGitBridge: process.env.GIT_BRIDGE_ENABLED === 'true',
    enableReviewPanel: process.env.REVIEW_PANEL_ENABLED === 'true',
    // The service account the MCP comment tools speak as, so that replies and
    // resolutions made by an agent are attributable in the review panel.
    review: {
      agentUser: {
        email: process.env.REVIEW_AGENT_USER_EMAIL || 'agent@overleaf.local',
        firstName: 'Agent',
        lastName: process.env.REVIEW_AGENT_USER_NAME || 'MCP',
      },
    },
    gitBridgePublicBaseUrl:
      process.env.GIT_BRIDGE_PUBLIC_BASE_URL || `${settings.siteUrl}/git`,
    // One-way mirror of a project's git history to a GitHub repository. It
    // reads the history from the git-bridge container, so it needs git-bridge
    // enabled.
    githubBackup: {
      enabled: process.env.GITHUB_BACKUP_ENABLED === 'true',
      intervalSeconds: intFromEnv('GITHUB_BACKUP_INTERVAL_SECONDS', 600),
      reposDir:
        process.env.GITHUB_BACKUP_REPOS_DIR ||
        Path.resolve(__dirname, '../data/github-backup'),
      apiBaseUrl:
        process.env.GITHUB_BACKUP_API_BASE_URL || 'https://api.github.com',
      gitTimeoutMs: intFromEnv('GITHUB_BACKUP_GIT_TIMEOUT_MS', 5 * minutes),
      // The GitHub token and the internal git-bridge token are stored
      // encrypted with this key. Rotating it makes every existing link
      // unusable, so the owner has to connect the repository again.
      accessTokenEncryptor: {
        cipherLabel: '2026.1-v3',
        cipherPasswords: {
          '2026.1-v3': process.env.GITHUB_BACKUP_CIPHER_PASSWORD,
        },
      },
    },
    livePreview: {
      enabled: process.env.LIVE_PREVIEW_ENABLED === 'true',
      ticketSecret: process.env.LIVE_PREVIEW_TICKET_SECRET,
      serviceUrl:
        process.env.LIVE_PREVIEW_SERVICE_URL || 'http://127.0.0.1:3060',
    },
  })
}

module.exports = { apply }
