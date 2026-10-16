import { expect } from 'chai'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  markerStore,
  updateEditorState,
} from '../../../frontend/js/editor-state.mjs'
import { extension } from '../../../frontend/js/source-editor-extension'
import { livePreviewUserColor } from '../../../frontend/js/user-color'
import { getBackgroundColorForUserId } from '@/shared/utils/colors'

describe('live preview editor integration', function () {
  it('marks current-document missing glyph locations and replaces them with each pass', function () {
    const state = updateEditorState(
      { markers: new Map(), diagnostics: new Map() },
      {
        type: 'diagnostics',
        header: {
          source: 'missing-glyphs',
          items: [
            {
              message: 'Font has no glyphs for: 中',
              locations: [{ doc_id: 'main', range: { start: 0, end: 2 } }],
            },
          ],
        },
      }
    )
    markerStore.set(state.markers)
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '中文\nplain',
        extensions: extension({
          currentDoc: { currentDoc: { doc_id: 'main' } },
        }),
      }),
    })
    try {
      expect(
        parent.querySelectorAll(
          '[title="Live preview: Font has no glyphs for: 中"]'
        )
      ).to.have.length(1)
      const clean = updateEditorState(state, {
        type: 'diagnostics',
        header: { source: 'missing-glyphs', items: [] },
      })
      markerStore.set(clean.markers)
      expect(
        parent.querySelectorAll('.cm-live-preview-gutter [title]')
      ).to.have.length(0)
    } finally {
      view.destroy()
      parent.remove()
    }
  })
  afterEach(function () {
    markerStore.set(new Map())
  })

  it('uses collaborator cursor colours and a neutral colour for anonymous link identities', function () {
    expect(livePreviewUserColor('alice')).to.equal(
      getBackgroundColorForUserId('alice')
    )
    expect(livePreviewUserColor('bob')).to.equal(
      getBackgroundColorForUserId('bob')
    )
    expect(livePreviewUserColor('anonymous:abc123')).to.equal('#808080')
    expect(livePreviewUserColor('anonymous:def456')).to.equal('#808080')
  })

  it('marks only the shown document, maps edits, switches documents and clears markers', function () {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const markers = new Map([
      [
        1,
        {
          doc_id: 'chapter',
          range: { start: 1, end: 7 },
          reasons: ['unverified macro'],
        },
      ],
      [
        2,
        {
          doc_id: 'other',
          range: { start: 0, end: 1 },
          reasons: ['other file'],
        },
      ],
    ])
    markerStore.set(markers)
    const create = (docId: string) =>
      EditorState.create({
        doc: '中😀\ntext\n',
        extensions: extension({
          currentDoc: { currentDoc: { doc_id: docId } },
        }),
      })
    const view = new EditorView({ state: create('chapter'), parent })
    try {
      expect(
        parent.querySelectorAll('[title="Live preview: unverified macro"]')
      ).to.have.length(2)
      expect(
        parent.querySelector('[title="Live preview: other file"]')
      ).to.equal(null)
      view.dispatch({ changes: { from: 0, insert: '\n' } })
      markerStore.set(new Map(markers))
      expect(
        parent.querySelectorAll('[title="Live preview: unverified macro"]')
      ).to.have.length(2)
      expect(
        parent.querySelector('.cm-live-preview-gutter .cm-gutterElement[title]')
      ).to.equal(null)
      view.setState(create('other'))
      expect(
        parent.querySelectorAll('[title="Live preview: other file"]')
      ).to.have.length(1)
      markerStore.set(new Map())
      expect(parent.querySelector('.cm-live-preview-gutter [title]')).to.equal(
        null
      )
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('clears only units incorporated in a layout and retains newer errors', function () {
    let state = { markers: new Map(), diagnostics: new Map() }
    const frame = (type: string, header: Record<string, any>) => {
      state = updateEditorState(state, { type, header })
    }
    frame('background', {
      par_id: 1,
      reasons: ['slow'],
      versions: { source_revision: 1 },
    })
    frame('paragraph', {
      par_id: 2,
      status: 'error',
      diagnostics: [{ message: 'TeX error' }],
      versions: { source_revision: 3 },
    })
    frame('layout', {
      placements: [{ par_id: 1 }, { par_id: 2 }],
      versions: { source_revision: 2 },
    })
    expect([...state.markers.keys()]).to.deep.equal([2])
    expect(state.markers.get(2).reasons).to.deep.equal(['TeX error'])
    frame('paragraph', { par_id: 2, status: 'ok' })
    expect(state.markers.size).to.equal(0)
    expect(state.diagnostics.size).to.equal(0)
    frame('diagnostics', { source: 'pass', items: [{ message: 'warning' }] })
    frame('diagnostics', { source: 'pass', items: [] })
    expect(state.diagnostics.get('pass')).to.deep.equal([])
  })
})
