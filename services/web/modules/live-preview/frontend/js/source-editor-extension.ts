import { RangeSet, StateEffect, StateField, Text } from '@codemirror/state'
import { EditorView, GutterMarker, gutter, ViewPlugin } from '@codemirror/view'
import { markerStore } from './editor-state.mjs'
import i18n from 'i18next'
import { noteLocalEdit } from './layout-scheduler.mjs'

export type Marker = {
  doc_id: string
  range?: { start: number; end: number }
  reasons: string[]
}

export type MarkerId = number | string

type MappedMarker = Marker & { original: Marker }

class PreviewMarker extends GutterMarker {
  constructor(readonly reasons: string) {
    super()
  }

  eq(other: PreviewMarker) {
    return this.reasons === other.reasons
  }

  toDOM() {
    const dom = document.createElement('span')
    dom.textContent = '●'
    dom.title = `${i18n.t('live_preview')}: ${this.reasons}`
    dom.setAttribute('aria-label', dom.title)
    return dom
  }
}

const setMarkers = StateEffect.define<Map<MarkerId, Marker>>()
const markerTheme = EditorView.baseTheme({
  '.cm-live-preview-gutter': {
    color: '#b47700',
    cursor: 'help',
    fontSize: '9px',
  },
  '.cm-live-preview-gutter .cm-gutterElement': { padding: '0 3px' },
})

export function extension(options: {
  currentDoc: { currentDoc: { doc_id: string } }
}) {
  const docId = options.currentDoc.currentDoc.doc_id
  function reconcile(
    markers: Map<MarkerId, Marker>,
    doc: Text,
    previous = new Map<MarkerId, MappedMarker>()
  ) {
    const next = new Map<MarkerId, MappedMarker>()
    for (const [id, marker] of markers) {
      if (marker.doc_id !== docId) continue
      const mapped = previous.get(id)
      const range = mapped?.original === marker ? mapped.range : marker.range
      if (
        !range ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > doc.length
      )
        continue
      next.set(
        id,
        mapped?.original === marker ? mapped : { ...marker, original: marker }
      )
    }
    return next
  }

  const field = StateField.define<Map<MarkerId, MappedMarker>>({
    create(state) {
      return reconcile(markerStore.get(), state.doc)
    },
    update(value, transaction) {
      if (transaction.docChanged) {
        value = new Map(
          [...value].map(([id, marker]) => [
            id,
            {
              ...marker,
              range: marker.range && {
                start: transaction.changes.mapPos(marker.range.start, 1),
                end: transaction.changes.mapPos(marker.range.end, -1),
              },
            },
          ])
        )
      }
      for (const effect of transaction.effects) {
        if (effect.is(setMarkers))
          value = reconcile(effect.value, transaction.state.doc, value)
      }
      return value
    },
  })

  function ranges(doc: Text, markers: Map<MarkerId, Marker>) {
    const lines = new Map<number, string[]>()
    for (const marker of markers.values()) {
      if (marker.doc_id !== docId || !marker.range) continue
      const { start, end } = marker.range
      if (start < 0 || end < start || end > doc.length) continue
      const last = Math.max(start, end - 1)
      let line = doc.lineAt(start)
      while (line.from <= last) {
        lines.set(line.from, [
          ...(lines.get(line.from) || []),
          ...marker.reasons,
        ])
        if (line.to >= last) break
        line = doc.lineAt(line.to + 1)
      }
    }
    return RangeSet.of(
      [...lines].map(([from, reasons]) =>
        new PreviewMarker(reasons.join('\n')).range(from)
      ),
      true
    )
  }

  return [
    field,
    gutter({
      class: 'cm-live-preview-gutter',
      markers: view => ranges(view.state.doc, view.state.field(field)),
      lineMarkerChange: update =>
        update.startState.field(field) !== update.state.field(field),
    }),
    markerTheme,
    ViewPlugin.define(view => {
      const unsubscribe = markerStore.subscribe(
        (markers: Map<MarkerId, Marker>) => {
          view.dispatch({ effects: setMarkers.of(markers) })
        }
      )
      return {
        update(update) {
          if (update.docChanged) noteLocalEdit()
        },
        destroy: unsubscribe,
      }
    }),
  ]
}
