import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import UpdateMerger from '../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import VersionService from './VersionService.mjs'
import LabelService from './LabelService.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import { VersionConflictError } from './Errors.mjs'

async function writeFiles(
  projectId,
  userId,
  { baseVersion, message, agent, files = [], originExtra = {} }
) {
  return LockManager.promises.runWithLock(
    'project-sync',
    projectId,
    async () => {
      const current = await VersionService.promises.getLatestVersion(projectId)
      if (
        baseVersion != null &&
        String(current.version) !== String(baseVersion)
      )
        throw new VersionConflictError('project version conflict', {
          expectedVersion: baseVersion,
          actualVersion: current.version,
        })
      const origin = { ...originExtra, kind: 'mcp', agent, message }
      const applied = []
      const failed = []
      const unchanged = []
      const tempPaths = []
      try {
        let docs
        const hasDocCandidates = files.some(
          item => !item.delete && item.contentBase64 == null
        )
        if (hasDocCandidates) {
          try {
            ;[, docs] = await Promise.all([
              ProjectEntityHandler.promises.getAllEntities(projectId),
              ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
                projectId
              ),
            ])
          } catch (error) {
            logger.warn(
              { err: error, projectId },
              'failed to load project entities for unchanged detection'
            )
          }
        }
        for (const item of files) {
          const target = String(item.path || '').replace(/^\/+/, '')
          try {
            if (!item.delete && item.contentBase64 == null) {
              try {
                const docEntry = Object.entries(docs || {}).find(
                  ([, pathname]) =>
                    String(pathname).replace(/^\/+/, '') === target
                )
                if (docEntry) {
                  const document =
                    await DocumentUpdaterHandler.promises.getDocument(
                      projectId,
                      docEntry[0],
                      -1
                    )
                  const lines = Array.isArray(document.lines)
                    ? document.lines
                    : String(document.lines || '').split(/\r\n|\n|\r/)
                  if (lines.join('\n') === String(item.content ?? '')) {
                    unchanged.push(target)
                    continue
                  }
                }
              } catch (error) {
                logger.warn(
                  { err: error, projectId, path: target },
                  'failed to compare project document for unchanged detection'
                )
              }
            }
            if (item.delete) {
              const entities =
                await ProjectEntityHandler.promises.getAllEntities(projectId)
              const exists = [
                ...(entities.docs || []),
                ...(entities.files || []),
              ].some(
                entity => String(entity.path).replace(/^\/+/, '') === target
              )
              if (!exists) {
                unchanged.push(target)
                continue
              }
              await UpdateMerger.promises.deleteUpdate(
                userId,
                projectId,
                '/' + target,
                origin
              )
              const ents =
                await ProjectEntityHandler.promises.getAllEntities(projectId)
              if (
                [...(ents.docs || []), ...(ents.files || [])].some(
                  e => String(e.path).replace(/^\/+/, '') === target
                )
              )
                throw new Error('delete failed: path still exists')
            } else {
              const content =
                item.contentBase64 != null
                  ? Buffer.from(item.contentBase64, 'base64')
                  : Buffer.from(String(item.content ?? ''), 'utf8')
              const fsPath = path.join(
                Settings.path.dumpFolder,
                `${projectId}_${crypto.randomUUID()}_project-sync`
              )
              tempPaths.push(fsPath)
              await fs.writeFile(fsPath, content)
              await UpdateMerger.promises._mergeUpdate(
                userId,
                projectId,
                '/' + target,
                fsPath,
                origin
              )
            }
            applied.push(target)
          } catch (error) {
            failed.push({ path: target, error: error.message })
          }
        }
        const after = await VersionService.promises.getLatestVersion(projectId)
        if (applied.length === 0) {
          return {
            version: after.version,
            label: null,
            applied,
            ...(files.length ? { unchanged } : {}),
            failed,
          }
        }
        const labelComment = originExtra.revert
          ? `${message} (reverted from ${originExtra.revert.from} to ${originExtra.revert.to})`
          : message
        const label = await LabelService.promises.createLabel(
          projectId,
          userId,
          after.version,
          labelComment
        )
        return {
          version: after.version,
          label: {
            id: label.id ?? label._id,
            comment: label.comment ?? message,
          },
          applied,
          unchanged,
          failed,
        }
      } finally {
        await Promise.all(tempPaths.map(p => fs.unlink(p).catch(() => {})))
      }
    }
  )
}
export default { writeFiles, promises: { writeFiles } }
