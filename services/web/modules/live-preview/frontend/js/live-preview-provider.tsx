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
import { createLease, setLiveFlushDelay } from './flush-delay.mjs'
import { connectPreview } from './connection.mjs'
import { accessUrl } from './protocol.mjs'

export type PreviewFrame = {
  type: string
  header: Record<string, any>
  body: Uint8Array
}

type PreviewState = {
  engine: string
  connection: string
  convergence?: string
  layout?: PreviewFrame['header']
  paragraphs: Map<number, PreviewFrame>
}

type LivePreviewContextValue = PreviewState & {
  available: boolean
  enabled: boolean
  active: boolean
  setEnabled: (enabled: boolean) => void
  getAccess: () => string
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
  const access = useRef('')
  const getAccess = useCallback(() => access.current, [])
  const [lease] = useState(() =>
    createLease((active: boolean) => setLiveFlushDelay(active ? 150 : null))
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
    const close = connectPreview({
      project: projectId,
      getTicket: (signal: AbortSignal) =>
        postJSON(`/project/${projectId}/live-preview/ticket`, { signal }),
      onState: (connection: string) =>
        setState(previous => ({ ...previous, connection })),
      onFrame: ({ type, header, body }: PreviewFrame) => {
        if (type === 'hello' || type === 'access')
          access.current = header.access
        if (type === 'layout' && header.pdf_url && access.current) {
          setPreviewUrl?.(accessUrl(header.pdf_url, access.current))
        }
        setState(previous => {
          switch (type) {
            case 'hello':
              return {
                ...previous,
                engine: header.engine_state,
                paragraphs: new Map(),
              }
            case 'layout':
              if (!header.pdf_url) return previous
              return {
                ...previous,
                layout: header,
                convergence: header.convergence,
                paragraphs: new Map(),
              }
            case 'paragraph': {
              if (header.status === 'error') return previous
              const paragraphs = new Map(previous.paragraphs)
              paragraphs.set(header.par_id, { type, header, body })
              return { ...previous, paragraphs }
            }
            case 'engine':
              return { ...previous, engine: header.state }
            case 'busy':
              return { ...previous, engine: 'Busy' }
            default:
              return previous
          }
        })
      },
    })
    return () => {
      close()
      setPreviewUrl?.(undefined)
    }
  }, [enabled, projectId, setPreviewUrl])

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
    }),
    [state, available, enabled, suspended, setEnabled, getAccess]
  )
  return (
    <LivePreviewContext.Provider value={value}>
      {children}
    </LivePreviewContext.Provider>
  )
}
