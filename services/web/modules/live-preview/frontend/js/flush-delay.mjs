let liveDelay = null
const listeners = new Set()

export function getFlushDelay(fallback) {
  return liveDelay ?? fallback
}

export function setLiveFlushDelay(delay) {
  liveDelay = delay
  for (const listener of listeners) listener()
}

export function subscribeFlushDelay(listener) {
  listeners.add(listener)
  listener()
  return () => listeners.delete(listener)
}

export function createLease(setActive, timers = globalThis) {
  let timer
  function clear() {
    timers.clearTimeout(timer)
    setActive(false)
  }
  function refresh({ leaseMs } = {}) {
    clear()
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) return
    setActive(true)
    timer = timers.setTimeout(clear, Math.min(leaseMs, 2147483647))
  }
  return { refresh, clear }
}
