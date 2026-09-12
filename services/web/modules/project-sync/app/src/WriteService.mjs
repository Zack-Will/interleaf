import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import UpdateMerger from '../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import VersionService from './VersionService.mjs'
import LabelService from './LabelService.mjs'
import { VersionConflictError } from './Errors.mjs'

async function writeFiles(
  projectId,
  userId,
  {
    baseVersion,
    message,
    agent,
    files = [],
    originExtra = {},
    originKind = 'mcp',
  }
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
      const origin = { ...originExtra, kind: originKind, agent, message }
      const applied = []
      const failed = []
      const tempPaths = []
      try {
        for (const item of files) {
          const target = String(item.path || '').replace(/^\/+/, '')
          try {
            if (item.delete) {
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
          return { version: after.version, label: null, applied, failed }
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
          failed,
        }
      } finally {
        await Promise.all(tempPaths.map(p => fs.unlink(p).catch(() => {})))
      }
    }
  )
}
export default { writeFiles, promises: { writeFiles } }
