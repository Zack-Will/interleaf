import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Materializer } from './Materializer.mjs'
import { RtexProcess } from './RtexProcess.mjs'
import { SessionManager } from './SessionManager.mjs'
import { OpsConsumer } from './OpsConsumer.mjs'
import { FontRegistry } from './FontRegistry.mjs'
import { createHttpClients } from './HttpClients.mjs'
import { createServer } from './Server.mjs'
import { PreviewError } from './Errors.mjs'

const runFile = promisify(execFile)

export async function createService({
  settings,
  subscriber,
  publisher,
  clients = createHttpClients(settings),
  createEngine = () => new RtexProcess({ settings }),
  fonts,
  onError = () => {},
}) {
  if (
    !settings.ticketSecret ||
    settings.maxSessions < 1 ||
    settings.layoutMaxWaitMs <= 0 ||
    !Number.isSafeInteger(settings.accessTtlMs) ||
    settings.accessTtlMs < 2
  ) {
    throw new PreviewError(
      'invalid_config',
      'Ticket secret and positive session/layout budgets and access TTL are required'
    )
  }
  if (!fonts) {
    const fontkit = await import('fontkit')
    fonts = new FontRegistry({
      settings,
      parseFont: bytes => fontkit.create(bytes),
      locateFont: async name => {
        const { stdout } = await runFile('kpsewhich', [name], { timeout: 5000 })
        return stdout.trim()
      },
    })
  }
  const materializer = new Materializer({ settings, ...clients })
  const manager = new SessionManager({
    settings,
    materializer,
    createEngine,
    publisher,
    fonts,
    onError,
  })
  const consumer = new OpsConsumer({
    subscriber,
    manager,
    materializer,
    fetchDocument: clients.fetchDocument,
    driftMs: settings.driftMs,
    onError,
  })
  const server = createServer({ settings, manager, fonts, onError })

  async function start() {
    await consumer.start()
    await new Promise((resolve, reject) => {
      server.server.once('error', reject)
      server.server.listen(settings.port, settings.host, resolve)
    })
    return server.server.address()
  }

  async function stop() {
    await consumer.stop()
    await server.close()
    await manager.shutdown()
  }

  return { ...server, manager, consumer, fonts, start, stop }
}
