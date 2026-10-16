import { decodeDisplayList } from './protocol.mjs'

const listeners = new Set()

export function noteLocalEdit() {
  for (const listener of listeners) listener()
}

export function subscribeLocalEdits(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function needsBasePdf({ header, body }) {
  if (
    header.pagination_stale ||
    ['removed', 'ok_degraded'].includes(header.status) ||
    (header.status === 'ok' && !header.fragments?.length) ||
    header.fragments?.some(fragment => fragment.approximate)
  )
    return true
  try {
    return Boolean(body?.length && decodeDisplayList(body).degraded)
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
