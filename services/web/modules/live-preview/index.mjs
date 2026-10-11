import Settings from '@overleaf/settings'
import AuthenticationController from '../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import SessionManager from '../../app/src/Features/Authentication/SessionManager.mjs'
import ProjectGetter from '../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../app/src/Features/Project/ProjectEntityHandler.mjs'
import DocumentUpdaterHandler from '../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import HistoryManager from '../../app/src/Features/History/HistoryManager.mjs'
import { createLivePreviewService } from './app/src/LivePreviewService.mjs'
import { createLivePreviewRouter } from './app/src/LivePreviewRouter.mjs'

function apply(webRouter, privateApiRouter) {
  const settings = Settings.livePreview
  const service = createLivePreviewService({
    settings,
    getProject: ProjectGetter.promises.getProject,
    getEntities: ProjectEntityHandler.getAllEntitiesFromProject,
    getDocument: DocumentUpdaterHandler.promises.getDocument,
    getBlobUrl: HistoryManager.getFilestoreBlobURL,
  })
  const router = createLivePreviewRouter({
    settings,
    service,
    authorization: AuthorizationMiddleware.ensureUserCanReadProject,
    privateAuth: AuthenticationController.requirePrivateApiAuth(),
    getUserId: SessionManager.getLoggedInUserId,
  })
  router.apply(webRouter, privateApiRouter)
}

/** @import { WebModule } from '../../types/web-module' */
/** @type {WebModule} */
const LivePreviewModule = {
  router: { apply },
}

export default LivePreviewModule
