let delayOverride = null
const listeners = new Set()

export function getFlushDelay(fallback) {
  return delayOverride ?? fallback
}

export function setFlushDelay(delay) {
  delayOverride = delay
  for (const listener of listeners) listener()
}

export function subscribeFlushDelay(listener) {
  listeners.add(listener)
  listener()
  return () => listeners.delete(listener)
}
