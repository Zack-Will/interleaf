import { PreviewError } from './Errors.mjs'

export function createHttpClients(settings, fetchUrl = fetch) {
  const authorization = `Basic ${Buffer.from(`${settings.webUser}:${settings.webPassword}`).toString('base64')}`

  async function get(url, headers = {}) {
    let response
    try {
      response = await fetchUrl(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new PreviewError(
        'upstream_failed',
        'Live preview source service is unavailable'
      )
    }
    if (!response.ok) {
      throw new PreviewError(
        'upstream_failed',
        `Upstream returned ${response.status}`
      )
    }
    return response
  }

  async function readBounded(response, limit) {
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > limit) {
        throw new PreviewError(
          'snapshot_too_large',
          'Upstream response exceeds byte budget',
          413
        )
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async function readJson(response) {
    const bytes = await readBounded(
      response,
      settings.maxResponseBytes ?? 64 * 1024 ** 2
    )
    try {
      return JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new PreviewError('invalid_snapshot', 'Invalid upstream JSON')
    }
  }

  async function fetchSnapshot(projectId) {
    const response = await get(
      `${settings.webUrl}/internal/project/${projectId}/live-preview/snapshot`,
      { authorization }
    )
    return readJson(response)
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
    return readJson(response)
  }

  async function fetchBinary(url) {
    // Never forward the web API's credentials to filestore URLs.
    const response = await get(url)
    return readBounded(response, settings.maxFileBytes ?? 32 * 1024 ** 2)
  }

  return { fetchSnapshot, fetchDocument, fetchBinary }
}
