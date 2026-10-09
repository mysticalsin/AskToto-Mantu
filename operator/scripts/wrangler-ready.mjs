/**
 * The pinned Wrangler CLI forwards this JSON-string message from its own dev server.
 * Never select an endpoint from stdout or from an independently reserved and released port.
 * @param {unknown} message
 * @returns {string | null}
 */
export function wranglerReadyEndpoint(message) {
  let record
  try {
    if (typeof message !== 'string') throw new Error()
    record = JSON.parse(message)
  } catch {
    throw new Error('Invalid Wrangler readiness message')
  }
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    typeof record.event !== 'string' ||
    !record.event
  ) {
    throw new Error('Invalid Wrangler readiness message')
  }
  if (record.event !== 'DEV_SERVER_READY') return null
  if (
    Object.keys(record).length !== 3 ||
    record.ip !== '127.0.0.1' ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535
  ) {
    throw new Error('Invalid Wrangler readiness message')
  }
  return `http://127.0.0.1:${record.port}`
}

/**
 * One startup budget covers both IPC readiness and health. Settlement aborts the health request
 * and disposes only this waiter's listeners and timers; the caller still owns the child process.
 * @param {import('node:events').EventEmitter & {exitCode: number | null, signalCode: NodeJS.Signals | null}} child
 * @param {{deadline: number, now?: () => number,
 *   checkHealth: (base: string, signal: AbortSignal) => Promise<boolean>}} options
 * @returns {Promise<string>}
 */
export function waitForWranglerReady(child, { deadline, now = () => performance.now(), checkHealth }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    /** @type {string | null} */
    let endpoint = null
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadlineTimer
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let pollTimer

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      clearTimeout(pollTimer)
      child.removeListener('message', onMessage)
      child.removeListener('error', onStopped)
      child.removeListener('exit', onStopped)
      controller.abort()
      if (error) reject(error)
      else if (endpoint !== null) resolve(endpoint)
      else reject(new Error('Wrangler endpoint missing'))
    }

    function onDeadline() {
      finish(new Error('Wrangler startup deadline exceeded'))
    }

    function onStopped() {
      finish(new Error('Wrangler child stopped before readiness'))
    }

    async function pollHealth() {
      if (settled || !endpoint) return
      if (now() >= deadline) return onDeadline()
      let healthy = false
      try {
        healthy = await checkHealth(endpoint, controller.signal)
      } catch {
        // A not-yet-listening endpoint is retried within the original startup deadline.
      }
      if (settled) return
      if (now() >= deadline) return onDeadline()
      if (healthy === true) return finish(null)
      pollTimer = setTimeout(pollHealth, Math.min(500, deadline - now()))
    }

    function onMessage(message) {
      if (settled) return
      let announced
      try {
        announced = wranglerReadyEndpoint(message)
      } catch (error) {
        finish(error)
        return
      }
      if (!announced || endpoint) return
      endpoint = announced
      void pollHealth()
    }

    child.on('message', onMessage)
    child.on('error', onStopped)
    child.on('exit', onStopped)
    if (child.exitCode !== null || child.signalCode !== null) return onStopped()
    const remaining = deadline - now()
    if (!Number.isFinite(remaining) || remaining <= 0) return onDeadline()
    deadlineTimer = setTimeout(onDeadline, remaining)
  })
}
