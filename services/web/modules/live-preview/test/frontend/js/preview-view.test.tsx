import { ContextType, useState } from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import {
  DetachCompileProvider,
  useDetachCompileContext,
} from '@/shared/context/detach-compile-context'
import { DetachContext, DetachRole } from '@/shared/context/detach-context'
import { LayoutContext } from '@/shared/context/layout-context'
import { EditorContext } from '@/shared/context/editor-context'

function Probe() {
  const compile = useDetachCompileContext()
  return (
    <>
      <button onClick={() => compile.setPreviewUrl?.('/live-preview/pdf/p/1')}>
        Live layout
      </button>
      <button onClick={() => compile.setPreviewUrl?.('/live-preview/pdf/p/2')}>
        Next layout
      </button>
      <button onClick={() => compile.setPreviewUrl?.(undefined)}>
        Disable
      </button>
      <button onClick={compile.toggleLogs}>Logs</button>
      <button onClick={() => compile.setShowLogs(false)}>Back to PDF</button>
      <span data-testid="view">{compile.showLogs ? 'logs' : 'pdf'}</span>
      <span data-testid="url">{compile.pdfUrl}</span>
      <span data-testid="viewer">{compile.pdfViewer}</span>
      <span data-testid="error">{compile.error}</span>
      <span data-testid="download">{compile.pdfDownloadUrl}</span>
    </>
  )
}

describe('live PDF pane view', function () {
  afterEach(cleanup)

  for (const role of [null, 'detached'] as DetachRole[]) {
    for (const hasPdf of [false, true]) {
      it(`shows the live PDF after a failed CLSI compile (${role ?? 'editor'}, PDF=${hasPdf}) and keeps logs accessible`, function () {
        const handlers = new Set<(message: any) => void>()
        function Harness() {
          const [showLogs, setShowLogs] = useState(true)
          const local = {
            showLogs,
            setShowLogs,
            toggleLogs: () => setShowLogs(shown => !shown),
            pdfFile: hasPdf
              ? { pdfUrl: '/normal.pdf', pdfDownloadUrl: '/download.pdf' }
              : null,
            pdfViewer: 'native',
            error: 'compile-failed',
          } as unknown as ContextType<typeof LocalCompileContext>
          return (
            <LocalCompileContext.Provider value={local}>
              <DetachContext.Provider
                value={{
                  role,
                  setRole: sinon.spy(),
                  broadcastEvent: sinon.spy(),
                  addEventHandler: handler => handlers.add(handler),
                  deleteEventHandler: handler => handlers.delete(handler),
                }}
              >
                <LayoutContext.Provider
                  value={{} as ContextType<typeof LayoutContext>}
                >
                  <EditorContext.Provider
                    value={{} as ContextType<typeof EditorContext>}
                  >
                    <DetachCompileProvider>
                      <Probe />
                    </DetachCompileProvider>
                  </EditorContext.Provider>
                </LayoutContext.Provider>
              </DetachContext.Provider>
            </LocalCompileContext.Provider>
          )
        }
        render(<Harness />)
        expect(screen.getByTestId('view').textContent).to.equal('logs')
        fireEvent.click(screen.getByRole('button', { name: 'Live layout' }))
        expect(screen.getByTestId('view').textContent).to.equal('pdf')
        expect(screen.getByTestId('url').textContent).to.equal(
          '/live-preview/pdf/p/1'
        )
        expect(screen.getByTestId('viewer').textContent).to.equal('pdfjs')
        act(() => {
          for (const handler of handlers) {
            handler({ event: 'state-showLogs', data: { value: true } })
          }
        })
        expect(screen.getByTestId('view').textContent).to.equal('pdf')
        fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
        expect(screen.getByTestId('view').textContent).to.equal('logs')
        fireEvent.click(screen.getByRole('button', { name: 'Next layout' }))
        expect(screen.getByTestId('view').textContent).to.equal('logs')
        expect(screen.getByTestId('error').textContent).to.equal(
          'compile-failed'
        )
        expect(screen.getByTestId('download').textContent).to.equal(
          hasPdf ? '/download.pdf' : ''
        )
        fireEvent.click(screen.getByRole('button', { name: 'Back to PDF' }))
        expect(screen.getByTestId('view').textContent).to.equal('pdf')
        fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
        expect(screen.getByTestId('view').textContent).to.equal('logs')
        expect(screen.getByTestId('url').textContent).to.equal(
          hasPdf ? '/normal.pdf' : ''
        )
        expect(screen.getByTestId('viewer').textContent).to.equal('native')
        fireEvent.click(screen.getByRole('button', { name: 'Live layout' }))
        expect(screen.getByTestId('view').textContent).to.equal('pdf')
      })
    }
  }
})
