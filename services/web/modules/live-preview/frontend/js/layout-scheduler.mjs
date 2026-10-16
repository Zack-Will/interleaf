import { decodeDisplayList } from './protocol.mjs'
import { placedRows, rowRect } from './geometry.mjs'

const listeners = new Set()

export function noteLocalEdit() {
  for (const listener of listeners) listener()
}

export function subscribeLocalEdits(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function needsBasePdf({ header, body }, layout, pageSizes = new Map()) {
  if (header.status === 'error') return false
  const placement = layout?.placements?.find(
    unit => unit.par_id === header.par_id
  )
  if (!placement?.row_rects?.length || !Number.isInteger(layout?.pages_total))
    return true
  if (header.status === 'removed') return false
  if (header.status !== 'ok' || !header.fragments?.length || !body?.length)
    return true
  try {
    const list = decodeDisplayList(body)
    if (list.degraded) return true
    const rows = placedRows(list, header.fragments)
    if (
      rows.length !== list.lines.length ||
      new Set(rows.map(row => row.line)).size !== list.lines.length
    )
      return true
    // rtex estimates extra rows at the last known anchor. A height/row-count
    // change can wait for quiet as long as every row fits on an existing page.
    // pagination_stale describes downstream reflow, not a failed live drawing.
    return rows.some(row => {
      const rect = rowRect(row)
      // Fast rtex lists may omit page dimensions (zero in RTDL). Prefer the
      // actual base PDF's MediaBox, supplied through the P3 viewer exposure.
      const size = pageSizes.get(row.page) || {
        width: list.page_width,
        height: list.page_height,
      }
      return (
        !(size.width > 0 && size.height > 0) ||
        !Number.isInteger(row.page) ||
        row.page < 1 ||
        row.page > layout.pages_total ||
        ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.w > size.width ||
        rect.y + rect.h > size.height
      )
    })
  } catch {
    return true
  }
}

// Keep only the latest candidate. Fetch it once into a blob URL because the
// authenticated endpoint is no-store; a speculative HTTP fetch cannot warm it.
/**
 * @param {{ apply: (header: any, url: string) => void, prepare: (header: any) => Promise<string>, release?: (url: string) => void, onError?: (error: unknown) => void, now?: () => number, quietMs?: number }} options
 */
export function createLayoutScheduler({
  apply,
  prepare,
  release = () => {},
  onError = () => {},
  now = Date.now,
  quietMs = 1000,
}) {
  let lastEdit = -Infinity
  let urgentRevision = -1
  let pending
  let timer
  let stopped = false
  let current

  function reset() {
    clearTimeout(timer)
    if (pending?.ready) release(pending.url)
    if (current) release(current.url)
    pending = undefined
    current = undefined
    lastEdit = -Infinity
    urgentRevision = -1
  }

  function schedule() {
    clearTimeout(timer)
    if (!pending?.ready || stopped) return
    const urgent = pending.revision >= urgentRevision && urgentRevision >= 0
    const wait = current && !urgent ? quietMs - (now() - lastEdit) : 0
    if (wait > 0) {
      timer = setTimeout(schedule, wait)
      return
    }
    const candidate = pending
    pending = undefined
    const old = current
    current = candidate
    if (urgent) urgentRevision = -1
    apply(candidate.header, candidate.url)
    if (old) release(old.url)
  }

  return {
    reset,
    activity() {
      lastEdit = now()
      schedule()
    },
    requireBase(revision = 0) {
      urgentRevision = Math.max(urgentRevision, revision)
      schedule()
    },
    layout(header, revision) {
      clearTimeout(timer)
      if (pending?.ready) release(pending.url)
      const candidate = { header, revision, ready: false }
      pending = candidate
      Promise.resolve()
        .then(() => prepare(header))
        .then(url => {
          if (stopped || pending !== candidate) {
            release(url)
            return
          }
          Object.assign(candidate, { url, ready: true })
          schedule()
        })
        .catch(error => {
          if (!stopped && pending === candidate) {
            pending = undefined
            onError(error)
          }
        })
    },
    dispose() {
      stopped = true
      reset()
    },
  }
}
