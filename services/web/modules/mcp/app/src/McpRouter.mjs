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
import ReviewService from '../../../review/app/src/ReviewService.mjs'
import SuggestionService from '../../../review/app/src/SuggestionService.mjs'
import AgentUser from '../../../review/app/src/AgentUser.mjs'
import GithubBackupService from '../../../github-backup/app/src/GithubBackupService.mjs'
import UploadService from '../../../project-sync/app/src/UploadService.mjs'
import TokenService from '../../../project-sync/app/src/TokenService.mjs'
import { requireAccessToken } from '../../../project-sync/app/src/TokenAuthMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { expressify } from '@overleaf/promise-utils'
import { createMcpServer } from './McpTools.mjs'
import { createUploadHandler } from './UploadController.mjs'

const uploadRateLimiter = new RateLimiter('mcp-upload', {
  points: 60,
  duration: 60,
})

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
    ReviewService,
    SuggestionService,
    AgentUser,
    GithubBackupService,
    UploadService,
    TokenService,
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
  dependencies: ['project-sync', 'review', 'github-backup'],
  nonCsrfRouter: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      const middleware = requireAccessToken('mcp')
      publicApiRouter.post('/mcp', middleware, handle)
      publicApiRouter.get('/mcp', middleware, handle)
      publicApiRouter.delete('/mcp', middleware, handle)
      publicApiRouter.put(
        '/mcp/uploads',
        RateLimiterMiddleware.rateLimit(uploadRateLimiter, { ipOnly: true }),
        expressify(createUploadHandler(createDefaultServices()))
      )
    },
  },
}

export { handle }
export default McpModule
