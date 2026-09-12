// The MCP SDK uses package subpath exports that the repository resolver cannot
// currently inspect. The import is valid at runtime.
// eslint-disable-next-line import/no-unresolved -- subpath export
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import ProjectRef from '../../../project-sync/app/src/ProjectRef.mjs'
import SnapshotService from '../../../project-sync/app/src/SnapshotService.mjs'
import VersionService from '../../../project-sync/app/src/VersionService.mjs'
import LabelService from '../../../project-sync/app/src/LabelService.mjs'
import WriteService from '../../../project-sync/app/src/WriteService.mjs'
import RevertService from '../../../project-sync/app/src/RevertService.mjs'
import BranchService from '../../../project-sync/app/src/BranchService.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import { requireAccessToken } from '../../../project-sync/app/src/TokenAuthMiddleware.mjs'
import { createMcpServer } from './McpTools.mjs'

export function createDefaultServices() {
  return {
    ProjectRef,
    SnapshotService,
    VersionService,
    LabelService,
    WriteService,
    RevertService,
    BranchService,
    ProjectGetter,
    ProjectEntityHandler,
    fetchJson,
    settings: Settings,
  }
}

async function handle(request, response) {
  const clientName = request.body?.params?.clientInfo?.name
  const server = createMcpServer({
    services: createDefaultServices(),
    req: request,
    clientName,
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  await server.connect(transport)
  return transport.handleRequest(request, response, request.body)
}

const McpModule = {
  dependencies: ['project-sync'],
  nonCsrfRouter: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      const middleware = requireAccessToken('mcp')
      publicApiRouter.post('/mcp', middleware, handle)
      publicApiRouter.get('/mcp', middleware, handle)
      publicApiRouter.delete('/mcp', middleware, handle)
    },
  },
}

export { handle }
export default McpModule
