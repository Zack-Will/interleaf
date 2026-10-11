import { useTranslation } from 'react-i18next'
import PdfLogEntry from '@/features/pdf-preview/components/pdf-log-entry'
import { useDetachCompileContext } from '@/shared/context/detach-compile-context'
import { useLivePreviewContext } from './live-preview-provider'

export default function LivePreviewLogs() {
  const live = useLivePreviewContext()
  const { syncToEntry } = useDetachCompileContext()
  const { t } = useTranslation()
  if (!live?.enabled) return null
  const items = [...live.diagnostics.values()].flat().slice(0, 100)
  return (
    <div aria-label={t('live_preview_diagnostics')}>
      {items.map((item, index) => (
        <PdfLogEntry
          key={`${item.file}:${item.line}:${item.message}:${index}`}
          headerTitle={`${t('live_preview')}: ${item.message}`}
          level={item.severity === 'warning' ? 'warning' : 'error'}
          rawContent={item.context ?? undefined}
          sourceLocation={{ file: item.file ?? undefined, line: item.line }}
          onSourceLocationClick={syncToEntry}
        />
      ))}
    </div>
  )
}
