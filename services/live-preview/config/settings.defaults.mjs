export function settingsFromEnv(env = process.env) {
  return {
    host: env.LIVE_PREVIEW_HOST || '127.0.0.1',
    port: Number(env.LIVE_PREVIEW_PORT || 3060),
    baseDir: env.LIVE_PREVIEW_DATA_DIR || '/var/lib/overleaf/data/live-preview',
    ticketSecret: env.LIVE_PREVIEW_TICKET_SECRET,
    maxSessions: Number(env.LIVE_PREVIEW_MAX_SESSIONS || 2),
    idleMs: Number(env.LIVE_PREVIEW_IDLE_MS || 300000),
    layoutMaxWaitMs: Number(env.LIVE_PREVIEW_LAYOUT_MAX_WAIT_MS || 3000),
    driftMs: 30000,
    rtexBinary: env.LIVE_PREVIEW_RTEX_BINARY || '/usr/local/bin/rtex',
    texDir: env.RTEX_TEXDIR || '/usr/local/share/rtex/tex',
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
