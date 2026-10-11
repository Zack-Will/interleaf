import redis from '@overleaf/redis-wrapper'
import logger from '@overleaf/logger'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'
import { createService } from './Service.mjs'

logger.initialize('live-preview')
const settings = settingsFromEnv()
const subscriber = redis.createClient(settings.redis)
const publisher = redis.createClient(settings.redis)
const onError = error => logger.error({ err: error }, 'live-preview error')
subscriber.on('error', onError)
publisher.on('error', onError)
const service = await createService({
  settings,
  subscriber,
  publisher,
  onError,
})
const address = await service.start()
logger.info({ address }, 'live-preview listening')
let stopping = false

async function shutdown() {
  if (stopping) {
    return
  }
  stopping = true
  await service.stop()
  await subscriber.quit()
  await publisher.quit()
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown().catch(onError))
}
