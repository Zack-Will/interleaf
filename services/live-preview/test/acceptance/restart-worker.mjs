import { EventEmitter } from 'node:events'
import { createService } from '../../app/src/Service.mjs'
import { RtexProcess } from '../../app/src/RtexProcess.mjs'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'

class ReportingEngine extends RtexProcess {
  start(directory, rootDoc) {
    const result = super.start(directory, rootDoc)
    process.send({ enginePid: this.child.pid })
    return result
  }
}

process.once('message', async ({ baseDir, project, secret }) => {
  const settings = {
    ...settingsFromEnv(),
    baseDir,
    ticketSecret: secret,
    port: 0,
  }
  const subscriber = Object.assign(new EventEmitter(), {
    subscribe: async () => {},
    unsubscribe: async () => {},
  })
  const service = await createService({
    settings,
    onError: error =>
      process.send({ error: { code: error.code, message: error.message } }),
    subscriber,
    publisher: { publish: async () => {} },
    clients: {
      fetchSnapshot: async () => ({
        projectId: project,
        compiler: 'lualatex',
        rootDoc: 'main.tex',
        files: [],
        docs: [
          {
            id: 'doc',
            path: 'main.tex',
            version: 0,
            content:
              '\\documentclass{article}\n\\begin{document}Rebuilt after service restart.\\end{document}\n',
          },
        ],
      }),
      fetchDocument: async () => {
        throw new Error('unused')
      },
      fetchBinary: async () => {
        throw new Error('unused')
      },
    },
    createEngine: () => {
      return new ReportingEngine({ settings })
    },
  })
  const address = await service.start()
  process.send({ port: address.port })
  process.on('SIGTERM', async () => {
    await service.stop()
    process.exit(0)
  })
})
