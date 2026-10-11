import { createTicket } from '@overleaf/live-preview-protocol/Tickets.mjs'
import { LivePreviewError } from './Errors.mjs'

export function requireEnabled(settings) {
  if (!settings.enabled) {
    throw new LivePreviewError(
      'live_preview_disabled',
      'Live preview is not enabled on this server',
      404
    )
  }
}

function relativePath(path) {
  return path.replace(/^\//, '')
}

function rootPath(project, docs) {
  const root = docs.find(doc => doc.id === String(project.rootDoc_id))
  if (root) return root.path
  if (project.rootDoc_id == null) {
    const main = docs.find(doc => doc.path === 'main.tex')
    if (main) return main.path
    if (docs.length === 1) return docs[0].path
  }
  throw new LivePreviewError(
    'root_doc_missing',
    'No root document specified',
    409
  )
}

export function createLivePreviewService({
  settings,
  getProject,
  getEntities,
  getDocument,
  getBlobUrl,
  now = Date.now,
}) {
  async function loadProject(projectId, projection) {
    requireEnabled(settings)
    if (!/^[a-f0-9]{24}$/i.test(projectId)) {
      throw new LivePreviewError(
        'invalid_project',
        'Expected a project id',
        400
      )
    }
    const project = await getProject(projectId, projection)
    if (!project) {
      throw new LivePreviewError('project_not_found', 'Project not found', 404)
    }
    return project
  }

  async function issueTicket(projectId, userId) {
    const project = await loadProject(projectId, { compiler: 1 })
    if (project.compiler !== 'lualatex') {
      throw new LivePreviewError(
        'compiler_not_lualatex',
        'Live preview requires LuaLaTeX',
        409
      )
    }
    if (!userId) {
      throw new LivePreviewError('login_required', 'Please log in', 401)
    }
    if (!settings.ticketSecret) {
      throw new LivePreviewError(
        'ticket_secret_missing',
        'Live preview ticket secret is not configured',
        503
      )
    }
    const issuedAt = now()
    return {
      ticket: createTicket(
        projectId,
        String(userId),
        settings.ticketSecret,
        issuedAt
      ),
      expiry: issuedAt + 60000,
    }
  }

  async function snapshot(projectId) {
    const project = await loadProject(projectId, {
      rootFolder: 1,
      rootDoc_id: 1,
      compiler: 1,
      'overleaf.history.id': 1,
    })
    const entities = getEntities(project)
    const docs = []
    // Bound document-updater traffic on large projects. These reads never flush
    // or touch the project state hash used by incremental CLSI compiles.
    for (const { doc, path } of entities.docs) {
      const id = String(doc._id)
      const current = await getDocument(projectId, id, -1)
      docs.push({
        id,
        path: relativePath(path),
        content: current.lines.join('\n'),
        version: current.version,
      })
    }
    const files = []
    const historyId = project.overleaf?.history?.id
    for (const { file, path } of entities.files) {
      if (!historyId || !file.hash) {
        throw new LivePreviewError(
          'blob_missing',
          'Project file has no history blob',
          409
        )
      }
      files.push({
        id: String(file._id),
        path: relativePath(path),
        // Same helper CLSI uses, including global blobs and immutable hashes.
        blobUrl: getBlobUrl(historyId, file.hash),
      })
    }
    return {
      projectId,
      compiler: project.compiler,
      rootDoc: rootPath(project, docs),
      docs,
      files,
    }
  }

  return { issueTicket, snapshot }
}
