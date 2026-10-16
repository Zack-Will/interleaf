import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  PropsWithChildren,
} from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import { useConnectionContext } from '@/features/ide-react/context/connection-context'
import useSocketListener from '@/features/ide-react/hooks/use-socket-listener'
import usePersistedState from '@/shared/hooks/use-persisted-state'
import useDetachStateWatcher from '@/shared/hooks/use-detach-state-watcher'
import { useDetachCompileContext } from '@/shared/context/detach-compile-context'
import { useLocalCompileContext } from '@/shared/context/local-compile-context'
import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import { setFlushDelay } from '@/shared/flush-delay.mjs'
import { createLease } from './flush-delay.mjs'
import { connectPreview } from './connection.mjs'
import { accessUrl } from './protocol.mjs'
import { markerStore, updateEditorState } from './editor-state.mjs'
import type { Marker, MarkerId } from './source-editor-extension'
import { anchorParagraph, retainParagraphs } from './overlay-model.mjs'
import { snapshotRevision } from '@overleaf/live-preview-protocol/Layout.mjs'
import {
  createLayoutScheduler,
  needsBasePdf,
  subscribeLocalEdits,
} from './layout-scheduler.mjs'
import { debugConsole } from '@/utils/debugging'

export type PreviewFrame = {
  type: string
  header: Record<string, any>
  body: Uint8Array
}

type PreviewState = {
  engine: string
  connection: string
  convergence?: {
    state: 'Converged' | 'Converging' | 'Stale' | 'PassLimitReached'
    pass?: number
    passes?: number
    pending_since?: number
    reasons?: string[]
  }
  layout?: PreviewFrame['header']
  compile?: PreviewFrame['header']['compile']
  paragraphs: Map<number, PreviewFrame>
  markers: Map<MarkerId, Marker>
  diagnostics: Map<string, LiveDiagnostic[]>
}

type LiveDiagnostic = {
  severity: string
  file?: string | null
  line?: number | null
  message: string
  context?: string | null
}

type LivePreviewContextValue = PreviewState & {
  available: boolean
  enabled: boolean
  active: boolean
  setEnabled: (enabled: boolean) => void
  getAccess: () => string
  retry: () => void
  notice?: string
  dismissNotice: () => void
}

const LivePreviewContext = createContext<LivePreviewContextValue | undefined>(
  undefined
)

export function useLivePreviewContext() {
  return useContext(LivePreviewContext)
}

const emptyState = (): PreviewState => ({
  engine: 'Starting',
  connection: 'Disconnected',
  paragraphs: new Map(),
  markers: new Map(),
  diagnostics: new Map(),
})

export default function LivePreviewProvider({ children }: PropsWithChildren) {
  const { projectId, project } = useProjectContext()
  // Detached previews do not join the editor socket. Reuse the native metadata
  // channel for compiler eligibility; preview frames still use their own socket.
  const [compiler] = useDetachStateWatcher(
    'live-preview-compiler',
    project?.compiler,
    'detacher',
    'detached'
  )
  const { socket } = useConnectionContext()
  const { setPreviewUrl } = useDetachCompileContext()
  const { setAutoCompileSuspended } = useLocalCompileContext()
  const [preference, setEnabled] = usePersistedState(
    `live-preview:${projectId}`,
    false,
    { listen: true }
  )
  const available = Boolean(
    getMeta('ol-livePreviewEnabled') && compiler === 'lualatex'
  )
  const enabled = available && preference
  const [state, setState] = useState<PreviewState>(emptyState)
  const [retryCount, setRetryCount] = useState(0)
  const retry = useCallback(() => setRetryCount(count => count + 1), [])
  const [compilerNotice, setCompilerNotice] = useState(false)
  const [sharedCompilerNotice, setSharedCompilerNotice] = useDetachStateWatcher(
    'live-preview-compiler-notice',
    compilerNotice,
    'detacher',
    'detached'
  )
  const previousCompiler = useRef(compiler)
  const notice =
    compilerNotice || sharedCompilerNotice
      ? 'live_preview_compiler_changed'
      : enabled && state.engine === 'Busy'
        ? 'live_preview_busy'
        : enabled && state.engine === 'Failed'
          ? 'live_preview_failed'
          : undefined
  const [dismissedNotice, setDismissedNotice] = useState<string>()
  const dismissNotice = useCallback(() => setDismissedNotice(notice), [notice])

  useEffect(() => {
    if (
      previousCompiler.current === 'lualatex' &&
      compiler !== 'lualatex' &&
      preference
    ) {
      setEnabled(false)
      setCompilerNotice(true)
    }
    previousCompiler.current = compiler
  }, [compiler, preference, setEnabled])

  useEffect(() => {
    setDismissedNotice(undefined)
    if (enabled) {
      setCompilerNotice(false)
      setSharedCompilerNotice(false)
    }
  }, [enabled, state.engine, retryCount, setSharedCompilerNotice])
  const access = useRef('')
  const getAccess = useCallback(() => access.current, [])
  const [lease] = useState(() =>
    createLease((active: boolean) => setFlushDelay(active ? 150 : null))
  )
  const clearLease = useCallback(() => lease.clear(), [lease])
  const refreshLease = useCallback(
    (event: { leaseMs: number }) => lease.refresh(event),
    [lease]
  )
  useSocketListener(socket, 'livePreview.active', refreshLease)
  useSocketListener(socket, 'livePreview.inactive', clearLease)
  useSocketListener(socket, 'disconnect', clearLease)
  useSocketListener(socket, 'connect', clearLease)
  useEffect(() => clearLease, [clearLease])

  useEffect(() => {
    setState(emptyState())
    access.current = ''
    setPreviewUrl?.(undefined)
    if (!enabled) return
    const controller = new AbortController()
    let appliedLayout: PreviewFrame['header'] | undefined
    const scheduler = createLayoutScheduler({
      prepare: async (header: PreviewFrame['header']) => {
        const response = await fetch(
          accessUrl(header.pdf_url, access.current),
          {
            signal: controller.signal,
          }
        )
        if (!response.ok) throw new Error(`Preview PDF: ${response.status}`)
        return URL.createObjectURL(await response.blob())
      },
      release: (url: string) => URL.revokeObjectURL(url),
      apply: (header: PreviewFrame['header'], url: string) => {
        appliedLayout = header
        setState(previous => ({
          ...previous,
          layout: header,
          paragraphs: retainParagraphs(previous.paragraphs, header),
        }))
        setPreviewUrl?.(url)
      },
      onError: (error: unknown) => debugConsole.warn('Live preview PDF', error),
    })
    const unsubscribe = subscribeLocalEdits(() => scheduler.activity())
    const close = connectPreview({
      project: projectId,
      getTicket: (signal: AbortSignal) =>
        postJSON(`/project/${projectId}/live-preview/ticket`, { signal }),
      onState: (connection: string) =>
        setState(previous => ({ ...previous, connection })),
      onFrame: ({ type, header, body }: PreviewFrame) => {
        if (
          type === 'hello' ||
          type === 'busy' ||
          (type === 'engine' && header.state === 'Failed')
        ) {
          scheduler.reset()
          appliedLayout = undefined
        }
        if (type === 'hello' || type === 'access')
          access.current = header.access
        if (type === 'paragraph') {
          scheduler.activity()
          if (needsBasePdf({ header, body }))
            scheduler.requireBase(header.versions?.source_revision)
        }
        if (type === 'layout' && header.pdf_url && access.current)
          scheduler.layout(header, snapshotRevision(header))
        setState(previous => {
          const editor = updateEditorState(previous, { type, header })
          const next = { ...previous, ...editor }
          switch (type) {
            case 'hello':
              return {
                ...next,
                engine: header.engine_state,
                paragraphs: new Map(),
              }
            case 'layout':
              return {
                ...next,
                convergence: header.convergence,
                compile: header.compile,
              }
            case 'paragraph': {
              if (header.status === 'error') return next
              const paragraphs = new Map(previous.paragraphs)
              const frame = { type, header, body }
              const drawing =
                appliedLayout &&
                header.versions?.layout_version !==
                  appliedLayout.versions?.layout_version
                  ? anchorParagraph(frame, appliedLayout)
                  : frame
              paragraphs.set(header.par_id, drawing)
              return { ...next, paragraphs }
            }
            case 'engine':
              return { ...next, engine: header.state }
            case 'busy':
              return { ...next, engine: 'Busy' }
            default:
              return next
          }
        })
      },
    })
    return () => {
      close()
      unsubscribe()
      controller.abort()
      scheduler.dispose()
      setPreviewUrl?.(undefined)
    }
  }, [enabled, projectId, setPreviewUrl, retryCount])

  useEffect(() => {
    markerStore.set(enabled ? state.markers : new Map())
  }, [enabled, state.markers])
  useEffect(() => () => markerStore.set(new Map()), [])

  const suspended =
    enabled &&
    !['Busy', 'Failed'].includes(state.engine) &&
    state.connection !== 'Unavailable'
  useEffect(() => {
    setAutoCompileSuspended?.(suspended)
    return () => setAutoCompileSuspended?.(false)
  }, [setAutoCompileSuspended, suspended])

  useEffect(() => {
    if (!suspended) setPreviewUrl?.(undefined)
  }, [suspended, setPreviewUrl])

  const value = useMemo(
    () => ({
      ...state,
      available,
      enabled,
      active: suspended,
      setEnabled,
      getAccess,
      retry,
      notice: dismissedNotice === notice ? undefined : notice,
      dismissNotice,
    }),
    [
      state,
      available,
      enabled,
      suspended,
      setEnabled,
      getAccess,
      retry,
      notice,
      dismissedNotice,
      dismissNotice,
    ]
  )
  return (
    <LivePreviewContext.Provider value={value}>
      {children}
    </LivePreviewContext.Provider>
  )
}
