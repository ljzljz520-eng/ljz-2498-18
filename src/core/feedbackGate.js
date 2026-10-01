import { SYNC_EPSILON_PX } from './positionMapping.js'

export function createFeedbackGate({ now = () => Date.now(), ttlMs = 450 } = {}) {
  const suppress = new Map()
  const lastApplied = new Map()

  function beginProgrammatic(target, expectedTop, origin, meta = {}) {
    suppress.set(target, {
      origin,
      expectedTop,
      appliedAt: now(),
      expiresAt: now() + ttlMs,
      ...meta,
    })
  }

  function shouldIgnoreScroll(target, nextTop, origin, options = {}) {
    const record = suppress.get(target)
    const epsilon = options.epsilon ?? SYNC_EPSILON_PX
    if (!record) return false
    if (now() > record.expiresAt) {
      suppress.delete(target)
      return false
    }
    if (record.origin === origin) return true
    if (typeof record.expectedTop === 'number' &&
      Math.abs(nextTop - record.expectedTop) <= epsilon) {
      return true
    }
    // Browser clamping, lazy-image growth, fold changes and font swaps can move
    // a requested top. Treat one near-time matching-origin event as consumed,
    // but do not keep swallowing the user's later manual correction.
    if (now() - record.appliedAt < 80) return true
    suppress.delete(target)
    return false
  }

  function consume(target, origin) {
    const record = suppress.get(target)
    if (record && record.origin === origin) {
      suppress.delete(target)
      return record
    }
    return null
  }

  function release(target) {
    suppress.delete(target)
  }

  function rememberApplied(target, top) {
    lastApplied.set(target, { top, at: now() })
  }

  function isRecentDuplicate(target, top, maxAgeMs = 64) {
    const last = lastApplied.get(target)
    if (!last || now() - last.at > maxAgeMs) return false
    return Math.abs(last.top - top) <= SYNC_EPSILON_PX
  }

  function clear() {
    suppress.clear()
    lastApplied.clear()
  }

  return {
    beginProgrammatic,
    shouldIgnoreScroll,
    consume,
    release,
    rememberApplied,
    isRecentDuplicate,
    clear,
  }
}
