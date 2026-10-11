import path from 'node:path'

export function settingsFromEnv(env = process.env) {
  return {
    host: env.LIVE_PREVIEW_HOST || '127.0.0.1',
    port: Number(env.LIVE_PREVIEW_PORT || 3060),
    baseDir: env.LIVE_PREVIEW_DATA_DIR || '/var/lib/overleaf/data/live-preview',
    ticketSecret: env.LIVE_PREVIEW_TICKET_SECRET,
    accessTtlMs: Number(env.LIVE_PREVIEW_ACCESS_TTL_MS || 900000),
    maxSessions: Number(env.LIVE_PREVIEW_MAX_SESSIONS || 2),
    maxProjectConnections: Number(
      env.LIVE_PREVIEW_MAX_PROJECT_CONNECTIONS || 16
    ),
    maxUserConnections: Number(env.LIVE_PREVIEW_MAX_USER_CONNECTIONS || 8),
    heartbeatMs: Number(env.LIVE_PREVIEW_HEARTBEAT_MS || 30000),
    allowedOrigins: (env.LIVE_PREVIEW_ALLOWED_ORIGINS || '')
      .split(',')
      .filter(Boolean),
    maxSnapshotEntries: 2000,
    maxFileBytes: 32 * 1024 ** 2,
    maxSnapshotBytes: 256 * 1024 ** 2,
    maxResponseBytes: 64 * 1024 ** 2,
    idleMs: Number(env.LIVE_PREVIEW_IDLE_MS || 300000),
    activeLeaseRefreshMs: Number(
      env.LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS || 30000
    ),
    activeLeaseMs: 75000,
    layoutMaxWaitMs: Number(env.LIVE_PREVIEW_LAYOUT_MAX_WAIT_MS || 3000),
    driftMs: 30000,
    rtexBinary: env.LIVE_PREVIEW_RTEX_BINARY || '/usr/local/bin/rtex',
    texDir: env.RTEX_TEXDIR || '/usr/local/share/rtex/tex',
    texmfRoot:
      env.LIVE_PREVIEW_TEXMF_ROOT ||
      (env.RTEX_TEXLIVE_BIN
        ? path.resolve(env.RTEX_TEXLIVE_BIN, '../..')
        : '/usr/local/texlive'),
    // RLIMIT_AS, inherited by LuaLaTeX children, equivalent to ulimit -v.
    memoryBytes: Number(env.LIVE_PREVIEW_MEMORY_MB || 2048) * 1024 * 1024,
    commandTimeoutMs: 30000,
    webUrl: env.LIVE_PREVIEW_WEB_URL || 'http://127.0.0.1:3000',
    webUser: env.LIVE_PREVIEW_WEB_USER || 'overleaf',
    webPassword: env.LIVE_PREVIEW_WEB_PASSWORD || '',
    documentUpdaterUrl:
      env.LIVE_PREVIEW_DOCUMENT_UPDATER_URL || 'http://127.0.0.1:3003',
    redis: {
      host:
        env.LIVE_PREVIEW_REDIS_HOST ||
        env.PUBSUB_REDIS_HOST ||
        env.REDIS_HOST ||
        '127.0.0.1',
      port: Number(
        env.LIVE_PREVIEW_REDIS_PORT ||
          env.PUBSUB_REDIS_PORT ||
          env.REDIS_PORT ||
          6379
      ),
      password:
        env.LIVE_PREVIEW_REDIS_PASSWORD ||
        env.PUBSUB_REDIS_PASSWORD ||
        env.REDIS_PASSWORD ||
        undefined,
    },
    fontRoots: (
      env.LIVE_PREVIEW_FONT_ROOTS ||
      '/usr/local/texlive:/usr/share/texlive:/usr/share/fonts'
    ).split(':'),
  }
}
