import { PreviewError } from './Errors.mjs'

export function createHttpClients(settings, fetchUrl = fetch) {
  const authorization = `Basic ${Buffer.from(`${settings.webUser}:${settings.webPassword}`).toString('base64')}`

  async function get(url, headers = {}) {
    const response = await fetchUrl(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      throw new PreviewError(
        'upstream_failed',
        `Upstream returned ${response.status}`
      )
    }
    return response
  }

  async function fetchSnapshot(projectId) {
    const response = await get(
      `${settings.webUrl}/internal/project/${projectId}/live-preview/snapshot`,
      { authorization }
    )
    return response.json()
  }

  async function fetchDocument(projectId, docId, fromVersion) {
    const url = new URL(
      `/project/${projectId}/doc/${encodeURIComponent(docId)}`,
      settings.documentUpdaterUrl
    )
    if (fromVersion !== undefined) {
      url.searchParams.set('fromVersion', fromVersion)
    }
    const response = await get(url)
    return response.json()
  }

  async function fetchBinary(url) {
    // Never forward the web API's credentials to filestore URLs.
    const response = await get(url)
    return Buffer.from(await response.arrayBuffer())
  }

  return { fetchSnapshot, fetchDocument, fetchBinary }
}
