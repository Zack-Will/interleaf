// Shared within one window only. CodeMirror extensions subscribe without React.
export function createMarkerStore() {
  let markers = new Map()
  const listeners = new Set()
  return {
    get: () => markers,
    set(value) {
      markers = value
      for (const listener of listeners) listener(markers)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const markerStore = createMarkerStore()

export function updateEditorState(previous, { type, header }) {
  if (
    !['background', 'paragraph', 'layout', 'diagnostics', 'hello'].includes(
      type
    )
  ) {
    return { markers: previous.markers, diagnostics: previous.diagnostics }
  }
  const markers = new Map(previous.markers)
  const diagnostics = new Map(previous.diagnostics)
  const key = `paragraph:${header.par_id}`
  if (
    type === 'background' ||
    (type === 'paragraph' && header.status === 'error')
  ) {
    const reasons = [
      ...(header.reasons || []),
      ...(header.diagnostics || []).map(item => item.message),
    ]
    if (header.par_id != null)
      markers.set(header.par_id, { ...header, reasons })
    if (header.status === 'error')
      diagnostics.set(key, header.diagnostics || [])
  } else if (type === 'paragraph') {
    markers.delete(header.par_id)
    diagnostics.delete(key)
  } else if (type === 'layout') {
    for (const unit of header.placements || []) {
      const marker = markers.get(unit.par_id)
      if (
        marker &&
        (marker.versions?.source_revision || 0) <=
          (header.versions?.source_revision || 0)
      ) {
        markers.delete(unit.par_id)
        diagnostics.delete(`paragraph:${unit.par_id}`)
      }
    }
  } else if (type === 'diagnostics') {
    diagnostics.set(header.source, header.items || [])
  } else if (type === 'hello') {
    markers.clear()
    diagnostics.clear()
  }
  return { markers, diagnostics }
}
