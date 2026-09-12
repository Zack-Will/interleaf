import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
async function getLatestVersion(projectId) {
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  await HistoryManager.promises.flushProject(projectId)
  return await fetchJson(`${Settings.apis.project_history.url}/project/${projectId}/version`)
}
export default { getLatestVersion, promises: { getLatestVersion } }
