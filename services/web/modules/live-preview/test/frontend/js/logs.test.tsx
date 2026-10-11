import { ContextType, PropsWithChildren } from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import {
  EditorProviders,
  makeEditorProvider,
} from '../../../../../test/frontend/helpers/editor-providers'
import { LocalCompileContext } from '@/shared/context/local-compile-context'
import { DetachCompileContext } from '@/shared/context/detach-compile-context'
import { FileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'
import PdfLogsEntries from '@/features/pdf-preview/components/pdf-logs-entries'
import LivePreviewCompileDropdownItem from '../../../frontend/js/compile-dropdown-item'
import LivePreviewOverlay from '../../../frontend/js/live-preview-overlay'
import { PdfPreviewProvider } from '@/features/pdf-preview/components/pdf-preview-provider'
import { encodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'

describe('live diagnostics in the native logs slot', function () {
  let nativeWebSocket: typeof WebSocket
  let previewSocket: { onmessage?: (event: { data: Uint8Array }) => void }

  beforeEach(function () {
    nativeWebSocket = globalThis.WebSocket
    globalThis.WebSocket = class {
      readyState = 1
      onmessage?: (event: { data: Uint8Array }) => void
      close = sinon.spy()
      send = sinon.spy()
      constructor() {
        previewSocket = this
      }
    } as unknown as typeof WebSocket
    window.metaAttributesCache.set('ol-livePreviewEnabled', true)
    localStorage.removeItem('live-preview:project123')
    fetchMock.post('/project/project123/live-preview/ticket', {
      ticket: 'open',
    })
  })

  afterEach(function () {
    cleanup()
    globalThis.WebSocket = nativeWebSocket
    window.metaAttributesCache.set('ol-livePreviewEnabled', false)
    window.metaAttributesCache.set('ol-detachRole', null)
    localStorage.removeItem('live-preview:project123')
    fetchMock.removeRoutes().clearHistory()
  })

  for (const role of [null, 'detached'] as const) {
    it(`renders alongside CLSI logs and jumps to file/line in the ${role ?? 'editor'} root`, async function () {
      window.metaAttributesCache.set('ol-detachRole', role)
      const syncToEntry = sinon.spy()
      const compile = {
        syncToEntry,
        setPreviewUrl: sinon.spy(),
        setAutoCompileSuspended: sinon.spy(),
      }
      function LocalProvider({ children }: PropsWithChildren) {
        return (
          <LocalCompileContext.Provider
            value={
              compile as unknown as ContextType<typeof LocalCompileContext>
            }
          >
            {children}
          </LocalCompileContext.Provider>
        )
      }
      function CompileProvider({ children }: PropsWithChildren) {
        return (
          <DetachCompileContext.Provider
            value={
              compile as unknown as ContextType<typeof DetachCompileContext>
            }
          >
            {children}
          </DetachCompileContext.Provider>
        )
      }
      function PathsProvider({ children }: PropsWithChildren) {
        return (
          <FileTreePathContext.Provider
            value={{
              findEntityByPath: () => ({
                type: 'doc',
                entity: { _id: 'main', name: 'main.tex' },
              }),
              pathInFolder: () => null,
              dirname: () => null,
              previewByPath: () => null,
            }}
          >
            {children}
          </FileTreePathContext.Provider>
        )
      }
      render(
        <EditorProviders
          compiler="lualatex"
          layoutContext={{ detachRole: role }}
          providers={{
            EditorProvider: makeEditorProvider(),
            LocalCompileProvider: LocalProvider,
            DetachCompileProvider: CompileProvider,
            FileTreePathProvider: PathsProvider,
          }}
        >
          <ul>
            <LivePreviewCompileDropdownItem />
          </ul>
          <PdfPreviewProvider>
            <LivePreviewOverlay />
          </PdfPreviewProvider>
          <PdfLogsEntries
            entries={[
              {
                key: 'clsi',
                raw: '',
                level: 'warning',
                message: 'Normal CLSI warning',
              },
            ]}
          />
        </EditorProviders>
      )
      fireEvent.click(screen.getByRole('menuitem', { name: 'Live preview' }))
      await waitFor(() => expect(previewSocket).not.to.equal(undefined))
      const send = (type: string, header: Record<string, any>) =>
        act(() =>
          previewSocket.onmessage?.({ data: encodeFrame(type, header) })
        )
      send('diagnostics', {
        source: 'background',
        items: [
          {
            severity: 'warning',
            file: 'main.tex',
            line: 12,
            message: 'Reference undefined',
          },
        ],
      })
      expect(screen.getByText('Normal CLSI warning')).to.exist
      const live = screen.getByLabelText('Live preview diagnostics')
      expect(within(live).getByText('Live preview: Reference undefined')).to
        .exist
      fireEvent.click(
        within(live).getByRole('button', { name: 'Go to code location' })
      )
      expect(syncToEntry).to.have.been.calledWith({
        file: 'main.tex',
        line: 12,
      })
      send('diagnostics', { source: 'background', items: [] })
      expect(screen.queryByText('Live preview: Reference undefined')).to.equal(
        null
      )
      send('paragraph', {
        par_id: 4,
        status: 'error',
        diagnostics: [
          {
            severity: 'error',
            file: 'main.tex',
            line: 3,
            message: 'Undefined control sequence',
          },
        ],
      })
      expect(screen.getByText('Live preview: Undefined control sequence')).to
        .exist
      fireEvent.click(screen.getByRole('menuitem', { name: 'Live preview' }))
      expect(screen.queryByLabelText('Live preview diagnostics')).to.equal(null)
      expect(screen.getByText('Normal CLSI warning')).to.exist
    })
  }
})
