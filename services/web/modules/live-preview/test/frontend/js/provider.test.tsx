import { EventEmitter } from 'events'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { ContextType } from 'react'
import { DetachContext, DetachRole } from '@/shared/context/detach-context'
import { ProjectContext } from '@/shared/context/project-context'
import { ConnectionContext } from '@/features/ide-react/context/connection-context'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import { DetachCompileContext } from '@/shared/context/detach-compile-context'
import LivePreviewProvider, {
  useLivePreviewContext,
} from '../../../frontend/js/live-preview-provider'
import { getFlushDelay } from '@/shared/flush-delay.mjs'
import LivePreviewCompileDropdownItem from '../../../frontend/js/compile-dropdown-item'
import { encodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'

const projectId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const ticketUrl = `/project/${projectId}/live-preview/ticket`

function Probe() {
  const live = useLivePreviewContext()!
  return (
    <>
      <ul>
        <LivePreviewCompileDropdownItem />
      </ul>
      <span data-testid="state">
        {String(live.enabled)}:{live.engine}:{live.layout?.layout_version}
      </span>
      <span data-testid="access">{live.getAccess()}</span>
    </>
  )
}

describe('LivePreviewProvider', function () {
  let socket: EventEmitter
  let setPreviewUrl: sinon.SinonSpy
  let setAutoCompileSuspended: sinon.SinonSpy
  let sockets: TestSocket[]
  let nativeWebSocket: typeof WebSocket
  let detachHandlers: Set<(message: any) => void>

  class TestSocket {
    readyState = 1
    send = sinon.spy()
    close = sinon.spy()
    onmessage?: (event: { data: Uint8Array }) => void
    constructor(readonly url: string) {
      sockets.push(this)
    }
  }

  function mount(
    compiler: string | undefined = 'lualatex',
    role: DetachRole = null
  ) {
    return render(
      <ProjectContext.Provider
        value={
          { projectId, project: { compiler } } as ContextType<
            typeof ProjectContext
          >
        }
      >
        <ConnectionContext.Provider
          value={{ socket } as unknown as ContextType<typeof ConnectionContext>}
        >
          <LocalCompileContext.Provider
            value={
              { setAutoCompileSuspended } as unknown as ContextType<
                typeof LocalCompileContext
              >
            }
          >
            <DetachCompileContext.Provider
              value={
                { setPreviewUrl } as unknown as ContextType<
                  typeof DetachCompileContext
                >
              }
            >
              <DetachContext.Provider
                value={{
                  role,
                  setRole: sinon.spy(),
                  broadcastEvent: sinon.spy(),
                  addEventHandler: handler => detachHandlers.add(handler),
                  deleteEventHandler: handler => detachHandlers.delete(handler),
                }}
              >
                <LivePreviewProvider>
                  <Probe />
                </LivePreviewProvider>
              </DetachContext.Provider>
            </DetachCompileContext.Provider>
          </LocalCompileContext.Provider>
        </ConnectionContext.Provider>
      </ProjectContext.Provider>
    )
  }

  beforeEach(function () {
    socket = new EventEmitter()
    setPreviewUrl = sinon.spy()
    setAutoCompileSuspended = sinon.spy()
    sockets = []
    detachHandlers = new Set()
    nativeWebSocket = globalThis.WebSocket
    globalThis.WebSocket = TestSocket as unknown as typeof WebSocket
    localStorage.removeItem(`live-preview:${projectId}`)
    window.metaAttributesCache.set('ol-livePreviewEnabled', true)
    window.metaAttributesCache.set('ol-csrfToken', 'csrf-token')
    fetchMock.removeRoutes().clearHistory()
    fetchMock.post(ticketUrl, { ticket: 'open-token' })
  })
  afterEach(function () {
    cleanup()
    globalThis.WebSocket = nativeWebSocket
    localStorage.removeItem(`live-preview:${projectId}`)
    window.metaAttributesCache.set('ol-livePreviewEnabled', false)
    fetchMock.removeRoutes().clearHistory()
  })

  it('gates by flag and compiler and listens to leases with the preview off', function () {
    const view = mount('pdflatex')
    expect(screen.queryByRole('menuitem', { name: 'Live preview' })).to.equal(
      null
    )
    act(() => {
      socket.emit('livePreview.active', { leaseMs: 75000 })
    })
    expect(getFlushDelay(2000)).to.equal(150)
    act(() => {
      socket.emit('disconnect')
    })
    expect(getFlushDelay(2000)).to.equal(2000)
    view.unmount()
    window.metaAttributesCache.set('ol-livePreviewEnabled', false)
    mount()
    expect(screen.queryByRole('menuitem', { name: 'Live preview' })).to.equal(
      null
    )
    expect(fetchMock.callHistory.called(ticketUrl)).to.equal(false)
  })

  it('persists the toggle, opens with CSRF, renews access and overrides only the preview URL', async function () {
    const view = mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Live preview' }))
    await waitFor(() => expect(sockets).to.have.length(1))
    expect(localStorage.getItem(`live-preview:${projectId}`)).to.equal('true')
    const request = fetchMock.callHistory.calls(ticketUrl)[0]
    expect(new Headers(request.options.headers).get('x-csrf-token')).to.equal(
      'csrf-token'
    )
    expect(setAutoCompileSuspended).to.have.been.calledWith(true)
    act(() => {
      sockets[0].onmessage?.({
        data: encodeFrame('hello', { engine_state: 'Ready', access: 'first' }),
      })
      sockets[0].onmessage?.({
        data: encodeFrame('access', { access: 'renewed' }),
      })
      sockets[0].onmessage?.({
        data: encodeFrame('layout', {
          layout_version: 4,
          convergence: 'Converged',
          pdf_url: `/live-preview/pdf/${projectId}/4`,
          placements: [],
        }),
      })
    })
    expect(screen.getByTestId('access').textContent).to.equal('renewed')
    expect(setPreviewUrl).to.have.been.calledWith(
      `/live-preview/pdf/${projectId}/4?ticket=renewed`
    )
    expect(screen.getByTestId('state').textContent).to.equal('true:Ready:4')
    view.unmount()
    expect(sockets[0].close).to.have.been.called
    expect(setAutoCompileSuspended.lastCall.args).to.deep.equal([false])
    expect(setPreviewUrl.lastCall.args).to.deep.equal([undefined])
    mount()
    await waitFor(() => expect(sockets).to.have.length(2))
  })

  it('restores normal autocompile and PDF on busy or failed engines', async function () {
    mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Live preview' }))
    await waitFor(() => expect(sockets).to.have.length(1))
    act(() => {
      sockets[0].onmessage?.({
        data: encodeFrame('busy', { reason: 'Budget full' }),
      })
    })
    expect(setAutoCompileSuspended.lastCall.args).to.deep.equal([false])
    expect(setPreviewUrl.lastCall.args).to.deep.equal([undefined])
  })

  it('opens a detached preview independently after native compiler metadata arrives', async function () {
    localStorage.setItem(`live-preview:${projectId}`, 'true')
    mount('', 'detached')
    expect(sockets).to.have.length(0)
    act(() => {
      for (const handler of detachHandlers)
        handler({
          event: 'state-live-preview-compiler',
          data: { value: 'lualatex' },
        })
    })
    await waitFor(() => expect(sockets).to.have.length(1))
    expect(sockets[0].url).to.include('ticket=open-token')
  })
})
