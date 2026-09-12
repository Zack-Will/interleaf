import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
const base = projectId => `${Settings.apis.project_history.url}/project/${projectId}/labels`
async function createLabel(projectId, userId, version, comment) { return fetchJson(base(projectId), { method: 'POST', json: { comment, version, user_id: userId } }) }
async function listLabels(projectId) { return fetchJson(base(projectId)) }
export default { createLabel, listLabels, promises: { createLabel, listLabels } }
