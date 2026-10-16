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
import LivePreviewOverlay from '../../../frontend/js/live-preview-overlay'
import { PdfPreviewProvider } from '@/features/pdf-preview/components/pdf-preview-provider'
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
      <span data-testid="drawing">{live.paragraphs.get(9)?.header.status}</span>
      <span data-testid="markers">
        {live.markers.get(9)?.reasons.join('; ')}
      </span>
      <PdfPreviewProvider>
        <LivePreviewOverlay />
      </PdfPreviewProvider>
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
  let createObjectURL: sinon.SinonStub
  let revokeObjectURL: sinon.SinonStub

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
    fetchMock.get(/\/live-preview\/pdf\//, { body: '%PDF-test' })
    createObjectURL = sinon.stub().returns('blob:preview')
    revokeObjectURL = sinon.stub()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  })
  afterEach(function () {
    cleanup()
    globalThis.WebSocket = nativeWebSocket
    localStorage.removeItem(`live-preview:${projectId}`)
    window.metaAttributesCache.set('ol-livePreviewEnabled', false)
    fetchMock.removeRoutes().clearHistory()
    delete (URL as Partial<typeof URL>).createObjectURL
    delete (URL as Partial<typeof URL>).revokeObjectURL
  })

  it('gates by flag and compiler and listens to leases with the preview off', function () {
    const view = mount('pdflatex')
    expect(screen.queryByRole('menuitem', { name: 'On' })).to.equal(null)
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
    expect(screen.queryByRole('menuitem', { name: 'On' })).to.equal(null)
    expect(fetchMock.callHistory.called(ticketUrl)).to.equal(false)
  })

  it('persists the toggle, opens with CSRF, renews access and overrides only the preview URL', async function () {
    const view = mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'On' }))
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
          convergence: { state: 'Converged' },
          pdf_url: `/live-preview/pdf/${projectId}/4`,
          placements: [],
        }),
      })
    })
    expect(screen.getByTestId('access').textContent).to.equal('renewed')
    await waitFor(() =>
      expect(setPreviewUrl).to.have.been.calledWith('blob:preview')
    )
    expect(
      fetchMock.callHistory.called(
        `/live-preview/pdf/${projectId}/4?ticket=renewed`
      )
    ).to.equal(true)
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'On' }))
    await waitFor(() => expect(sockets).to.have.length(1))
    act(() => {
      sockets[0].onmessage?.({
        data: encodeFrame('busy', { reason: 'Budget full' }),
      })
    })
    expect(setAutoCompileSuspended.lastCall.args).to.deep.equal([false])
    expect(setPreviewUrl.lastCall.args).to.deep.equal([undefined])
    expect(screen.getByRole('status').textContent).to.include(
      'unavailable right now'
    )
    expect(screen.getByRole('alert').textContent).to.include(
      'Normal compilation still works'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss live preview notice' })
    )
    expect(screen.queryByRole('alert')).to.equal(null)
  })

  it('retries a failed engine with a fresh socket and restores autocompile during failure', async function () {
    mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'On' }))
    await waitFor(() => expect(sockets).to.have.length(1))
    act(() =>
      sockets[0].onmessage?.({
        data: encodeFrame('engine', { state: 'Failed' }),
      })
    )
    expect(screen.getByRole('status').textContent).to.include('engine failed')
    expect(setAutoCompileSuspended.lastCall.args).to.deep.equal([false])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(sockets).to.have.length(2))
    expect(sockets[0].close).to.have.been.calledOnce
    expect(fetchMock.callHistory.calls(ticketUrl)).to.have.length(2)
    expect(sockets[1].close).not.to.have.been.called
    expect(screen.queryByRole('alert')).to.equal(null)
  })

  it('turns live mode off with a dismissible notice when the detached compiler changes', async function () {
    localStorage.setItem(`live-preview:${projectId}`, 'true')
    mount('lualatex', 'detached')
    await waitFor(() => expect(sockets).to.have.length(1))
    const changeCompiler = (compiler: string) =>
      act(() => {
        for (const handler of detachHandlers)
          handler({
            event: 'state-live-preview-compiler',
            data: { value: compiler },
          })
      })
    changeCompiler('pdflatex')
    expect(sockets[0].close).to.have.been.called
    expect(screen.queryByRole('menuitem', { name: 'On' })).to.equal(null)
    expect(screen.getByRole('alert').textContent).to.include('compiler changed')
    expect(localStorage.getItem(`live-preview:${projectId}`)).to.equal(null)
    changeCompiler('lualatex')
    expect(screen.getByTestId('state').textContent).to.include('false:')
    expect(sockets).to.have.length(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss live preview notice' })
    )
    expect(screen.queryByRole('alert')).to.equal(null)
  })

  for (const closeFirst of ['editor', 'detached']) {
    it(`keeps the other socket open when the ${closeFirst} window closes`, async function () {
      localStorage.setItem(`live-preview:${projectId}`, 'true')
      const editor = mount('lualatex', 'detacher')
      const detached = mount('lualatex', 'detached')
      await waitFor(() => expect(sockets).to.have.length(2))
      act(() => socket.emit('livePreview.active', { leaseMs: 75000 }))
      expect(getFlushDelay(2000)).to.equal(150)
      act(() => {
        sockets[1].onmessage?.({
          data: encodeFrame('hello', {
            engine_state: 'Ready',
            access: 'detached-access',
          }),
        })
        sockets[1].onmessage?.({
          data: encodeFrame('layout', {
            pdf_url: '/live-preview/pdf/p/1',
            layout_version: 1,
            placements: [],
          }),
        })
      })
      await waitFor(() =>
        expect(setPreviewUrl).to.have.been.calledWith('blob:preview')
      )
      expect(
        fetchMock.callHistory.called(
          '/live-preview/pdf/p/1?ticket=detached-access'
        )
      ).to.equal(true)
      expect(screen.getAllByRole('status')[1].textContent).to.include('Ready')
      if (closeFirst === 'editor') editor.unmount()
      else detached.unmount()
      const closedIndex = closeFirst === 'editor' ? 0 : 1
      expect(sockets[closedIndex].close).to.have.been.calledOnce
      expect(sockets[1 - closedIndex].close).not.to.have.been.called
      expect(localStorage.getItem(`live-preview:${projectId}`)).to.equal('true')
    })
  }

  it('receives the compiler-change notice even if storage disables the detached socket first', async function () {
    localStorage.setItem(`live-preview:${projectId}`, 'true')
    mount('lualatex', 'detached')
    await waitFor(() => expect(sockets).to.have.length(1))
    act(() => {
      localStorage.removeItem(`live-preview:${projectId}`)
      window.dispatchEvent(
        new StorageEvent('storage', { key: `live-preview:${projectId}` })
      )
    })
    expect(sockets[0].close).to.have.been.calledOnce
    act(() => {
      for (const handler of detachHandlers)
        handler({
          event: 'state-live-preview-compiler-notice',
          data: { value: true },
        })
    })
    expect(screen.getByRole('alert').textContent).to.include('compiler changed')
    fireEvent.click(screen.getByRole('menuitem', { name: 'On' }))
    await waitFor(() => expect(sockets).to.have.length(2))
    expect(screen.queryByRole('alert')).to.equal(null)
  })

  it('keeps the last drawing on TeX errors and marks the source until a live update or containing layout', async function () {
    mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'On' }))
    await waitFor(() => expect(sockets).to.have.length(1))
    const send = (type: string, header: Record<string, any>) =>
      act(() => sockets[0].onmessage?.({ data: encodeFrame(type, header) }))
    send('paragraph', { par_id: 9, status: 'ok' })
    send('paragraph', {
      par_id: 9,
      status: 'error',
      reasons: [],
      diagnostics: [{ message: 'Undefined control sequence' }],
      versions: { source_revision: 3 },
    })
    expect(screen.getByTestId('drawing').textContent).to.equal('ok')
    expect(screen.getByTestId('markers').textContent).to.equal(
      'Undefined control sequence'
    )
    send('layout', {
      placements: [{ par_id: 9 }],
      versions: { source_revision: 2 },
    })
    expect(screen.getByTestId('markers').textContent).to.equal(
      'Undefined control sequence'
    )
    send('layout', {
      placements: [{ par_id: 9 }],
      versions: { source_revision: 3 },
    })
    expect(screen.getByTestId('markers').textContent).to.equal('')
    send('background', { par_id: 9, reasons: ['Unverified macro'] })
    expect(screen.getByTestId('markers').textContent).to.equal(
      'Unverified macro'
    )
    send('paragraph', { par_id: 9, status: 'ok' })
    expect(screen.getByTestId('markers').textContent).to.equal('')
  })

  it('renders convergence objects as short labels and reports compile error counts', async function () {
    mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'On' }))
    await waitFor(() => expect(sockets).to.have.length(1))
    act(() => {
      sockets[0].onmessage?.({
        data: encodeFrame('hello', { engine_state: 'Ready', access: 'token' }),
      })
    })
    const statuses = [
      { convergence: { state: 'Converged' }, label: 'Converged' },
      {
        convergence: { state: 'Converging', pass: 2, reasons: ['references'] },
        label: 'Updating…',
      },
      { convergence: { state: 'Stale', pending_since: 3 }, label: 'Stale' },
      {
        convergence: {
          state: 'PassLimitReached',
          passes: 5,
          reasons: ['references'],
        },
        label: 'Pass limit reached',
      },
    ]
    for (const { convergence, label } of statuses) {
      act(() => {
        sockets[0].onmessage?.({
          data: encodeFrame('layout', {
            pdf_url: '/live-preview/pdf/p/1',
            convergence,
            compile: { state: 'Ok' },
          }),
        })
      })
      expect(screen.getByRole('status').textContent).to.equal(
        `Live preview: Ready · ${label}`
      )
    }
    for (const count of [1, 3]) {
      act(() => {
        sockets[0].onmessage?.({
          data: encodeFrame('layout', {
            pdf_url: '/live-preview/pdf/p/2',
            convergence: { state: 'Stale', pending_since: 4 },
            compile: { state: 'CompiledWithErrors', count },
          }),
        })
      })
      expect(screen.getByRole('status').textContent).to.equal(
        `Live preview: Ready · Stale · ${count} compile ${count === 1 ? 'error' : 'errors'}`
      )
    }
    act(() => {
      sockets[0].onmessage?.({
        data: encodeFrame('layout', {
          pdf_url: '/live-preview/pdf/p/3',
          convergence: { state: 'Converged' },
          compile: { state: 'Ok' },
        }),
      })
    })
    expect(screen.getByRole('status').textContent).to.equal(
      'Live preview: Ready · Converged'
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Off' }))
    expect(screen.queryByRole('status')).to.equal(null)
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
