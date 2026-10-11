import { useEffect, useRef } from 'react'
import { usePdfPreviewContext } from '@/features/pdf-preview/components/pdf-preview-provider'
import { getJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import { getBackgroundColorForUserId } from '@/shared/utils/colors'
import { debugConsole } from '@/utils/debugging'
import { useLivePreviewContext } from './live-preview-provider'
import { OverlayRenderer } from './overlay-renderer.mjs'
import { layoutStatusLabel } from './status.mjs'

export default function LivePreviewOverlay() {
  const live = useLivePreviewContext()
  const { pdfJsWrapper } = usePdfPreviewContext()
  const renderer = useRef<OverlayRenderer>()
  const enabled = live?.active
  const getAccess = live?.getAccess
  const layout = live?.layout
  const paragraphs = live?.paragraphs
  const status = layoutStatusLabel(live?.convergence, layout?.compile)

  useEffect(() => {
    if (!enabled || !pdfJsWrapper || !getAccess) return
    const instance = new OverlayRenderer({
      wrapper: pdfJsWrapper,
      getAccess,
      fetchJSON: getJSON,
      currentUser: getMeta('ol-user_id'),
      userColor: getBackgroundColorForUserId,
      onError: (error: unknown) =>
        debugConsole.warn('Live preview overlay', error),
    })
    renderer.current = instance
    return () => {
      instance.dispose()
      renderer.current = undefined
    }
  }, [enabled, pdfJsWrapper, getAccess])

  useEffect(() => {
    if (layout) renderer.current?.layout(layout)
  }, [layout, enabled, pdfJsWrapper])

  useEffect(() => {
    if (!paragraphs) return
    for (const frame of paragraphs.values())
      void renderer.current?.paragraph(frame)
  }, [paragraphs, layout, enabled, pdfJsWrapper])

  if (!live?.enabled) return null
  return (
    <span
      role="status"
      data-testid="live-preview-status"
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        pointerEvents: 'none',
        fontSize: 12,
      }}
    >
      Live preview: {live.engine}
      {status ? ` · ${status}` : ''}
      {live.connection !== 'Connected' ? ` · ${live.connection}` : ''}
    </span>
  )
}
