import { useEffect, useRef } from 'react'
import { usePdfPreviewContext } from '@/features/pdf-preview/components/pdf-preview-provider'
import { useDetachCompileContext } from '@/shared/context/detach-compile-context'
import { getJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import { useTranslation } from 'react-i18next'
import { debugConsole } from '@/utils/debugging'
import { useLivePreviewContext } from './live-preview-provider'
import { OverlayRenderer } from './overlay-renderer.mjs'
import { layoutStatusLabel } from './status.mjs'
import { livePreviewUserColor } from './user-color'

export default function LivePreviewOverlay() {
  const live = useLivePreviewContext()
  const { t } = useTranslation()
  const { pdfJsWrapper } = usePdfPreviewContext()
  const { activeOverallTheme } = useDetachCompileContext()
  const dark = activeOverallTheme === 'dark'
  const renderer = useRef<OverlayRenderer>()
  const enabled = live?.active
  const getAccess = live?.getAccess
  const reportPageSizes = live?.reportPageSizes
  const layout = live?.layout
  const paragraphs = live?.paragraphs
  const status = layoutStatusLabel(live?.convergence, live?.compile)

  useEffect(() => {
    if (!enabled || !pdfJsWrapper || !getAccess) return
    const instance = new OverlayRenderer({
      wrapper: pdfJsWrapper,
      getAccess,
      fetchJSON: getJSON,
      currentUser: getMeta('ol-user_id'),
      userColor: livePreviewUserColor,
      onPageSizes: reportPageSizes,
      onError: (error: unknown) =>
        debugConsole.warn('Live preview overlay', error),
    })
    renderer.current = instance
    return () => {
      instance.dispose()
      renderer.current = undefined
    }
  }, [enabled, pdfJsWrapper, getAccess, reportPageSizes])

  useEffect(() => {
    if (layout) renderer.current?.layout(layout)
  }, [layout, enabled, pdfJsWrapper])

  useEffect(() => {
    if (!paragraphs) return
    for (const frame of paragraphs.values())
      void renderer.current?.paragraph(frame)
  }, [paragraphs, layout, enabled, pdfJsWrapper])

  if (!live?.enabled && !live?.notice) return null
  const engineMessage =
    live?.engine === 'Busy'
      ? t('live_preview_busy')
      : live?.engine === 'Failed'
        ? t('live_preview_failed')
        : live?.engine
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        right: 8,
        zIndex: 5,
        fontSize: 12,
        padding: 6,
        background: dark ? 'var(--bg-dark-primary)' : 'var(--bg-light-primary)',
        color: dark ? 'var(--content-primary-dark)' : 'var(--content-primary)',
      }}
    >
      {live?.enabled && (
        <span role="status" data-testid="live-preview-status">
          {t('live_preview')}: {engineMessage}
          {status ? ` · ${status}` : ''}
          {live.connection !== 'Connected' ? ` · ${live.connection}` : ''}
          {live.engine === 'Failed' && (
            <>
              {' '}
              <button type="button" onClick={live.retry}>
                {t('live_preview_retry')}
              </button>
            </>
          )}
        </span>
      )}
      {live?.notice && (
        <div role="alert">
          {t(live.notice)}{' '}
          <button
            type="button"
            onClick={live.dismissNotice}
            aria-label={t('live_preview_dismiss')}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
