import Settings from '@overleaf/settings'
import ProjectEditorHandler from '../../app/src/Features/Project/ProjectEditorHandler.mjs'
import ReviewRouter from './app/src/ReviewRouter.mjs'

async function start() {
  if (Settings.enableReviewPanel) {
    ProjectEditorHandler.trackChangesAvailable = true
  }
}

export default {
  router: { apply: ReviewRouter.apply },
  start,
}
