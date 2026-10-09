/**
 * Bounded, content-free loopback diagnosis for a failed hosted Windows CDP attach. A protocol-shaped response
 * does not prove that this is the launched app: only attachOwnedCdp's process-info check can establish ownership.
 * This observer never follows redirects, opens a WebSocket, logs content, or returns endpoint data.
 */
import { request as httpRequest } from 'node:http'

const LOOPBACK = '127.0.0.1'
const MAX_RESPONSE_BYTES = 2_048
const REQUEST_TIMEOUT_MS = 350
const RETRY_MS = 250

const validPort = (value) => Number.isSafeInteger(value) && value > 0 && value <= 65_535
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function loopbackSocket(value, port, pathname) {
  if (typeof value !== 'string' || value.length > 256) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'ws:' &&
      parsed.hostname === LOOPBACK &&
      parsed.port === String(port) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      pathname(parsed.pathname)
    )
  } catch {
    return false
  }
}

/** Deliberately recognizes protocol shape, not process ownership. Never return or retain parsed content. */
export function endpointProtocolShape(kind, body, port) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES || !validPort(port)) return false
  try {
    const value = JSON.parse(body)
    if (kind === 'cdp') {
      return (
        record(value) &&
        typeof value.Browser === 'string' &&
        value.Browser.length > 0 &&
        loopbackSocket(value.webSocketDebuggerUrl, port, (path) => /^\/devtools\/browser\/[^/]+$/.test(path))
      )
    }
    if (kind === 'inspector') {
      return (
        Array.isArray(value) &&
        value.length === 1 &&
        record(value[0]) &&
        value[0].type === 'node' &&
        loopbackSocket(value[0].webSocketDebuggerUrl, port, (path) => /^\/[^/]+$/.test(path))
      )
    }
  } catch {
    return false
  }
  return false
}

function requestShape({ port, path, kind, deadline, signal, request }) {
  return new Promise((resolve) => {
    const remaining = deadline - performance.now()
    if (signal.aborted || remaining <= 0) {
      resolve(false)
      return
    }
    let req
    let response
    let timer
    let settled = false
    let bytes = 0
    const chunks = []
    const finish = (observed) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // Destroy even after a successful read so a malformed or slow peer cannot hold a runner socket open.
      let released = true
      try {
        req?.destroy()
      } catch {
        released = false
      }
      try {
        response?.destroy()
      } catch {
        released = false
      }
      resolve(observed && released)
    }
    const abort = () => finish(false)
    try {
      req = request(
        {
          protocol: 'http:',
          hostname: LOOPBACK,
          port,
          path,
          method: 'GET',
          agent: false,
          headers: { Accept: 'application/json' }
        },
        (received) => {
          if (settled) {
            received.destroy()
            return
          }
          response = received
          if (received.statusCode !== 200 || Number(received.headers?.['content-length']) > MAX_RESPONSE_BYTES) {
            finish(false)
            return
          }
          received.on('data', (chunk) => {
            if (settled) return
            bytes += chunk.length
            if (bytes > MAX_RESPONSE_BYTES) {
              finish(false)
              return
            }
            chunks.push(chunk)
          })
          received.once('end', () => {
            if (!settled) finish(endpointProtocolShape(kind, Buffer.concat(chunks).toString('utf8'), port))
          })
          received.on('error', () => finish(false))
        }
      )
      req.on('error', () => finish(false))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(false), Math.min(REQUEST_TIMEOUT_MS, remaining))
      if (signal.aborted) finish(false)
      else req.end()
    } catch {
      finish(false)
    }
  })
}

/**
 * Start both fixed-path probes without waiting for them. The caller passes the same monotonic deadline as its
 * Playwright attach and calls cancel() synchronously before teardown. A missed response is never proof of absence.
 * @param {{ cdpPort: number, inspectPort: number, deadline: number, request?: typeof httpRequest }} options
 */
export function observeLoopbackProtocols({ cdpPort, inspectPort, deadline, request = httpRequest }) {
  let cdpObserved = false
  let inspectorObserved = false
  let closed = false
  const controller = new AbortController()
  let deadlineTimer
  const diagnostic = () => {
    if (cdpObserved && inspectorObserved) return 'BOTH_PROTOCOL_SHAPES_OBSERVED'
    if (cdpObserved) return 'CDP_PROTOCOL_SHAPE_OBSERVED'
    if (inspectorObserved) return 'INSPECTOR_PROTOCOL_SHAPE_OBSERVED'
    return 'NOT_OBSERVED'
  }
  const cancel = () => {
    if (!closed) {
      closed = true
      clearTimeout(deadlineTimer)
      controller.abort()
    }
    return diagnostic()
  }
  if (!validPort(cdpPort) || !validPort(inspectPort) || cdpPort === inspectPort || !Number.isFinite(deadline)) {
    return { cancel, settled: Promise.resolve() }
  }
  const remaining = deadline - performance.now()
  if (remaining <= 0) return { cancel, settled: Promise.resolve() }
  deadlineTimer = setTimeout(cancel, remaining)
  const probe = async (port, path, kind) => {
    while (!closed && performance.now() < deadline) {
      const observed = await requestShape({ port, path, kind, deadline, signal: controller.signal, request })
      if (closed) return
      if (observed) {
        if (kind === 'cdp') cdpObserved = true
        else inspectorObserved = true
        if (cdpObserved && inspectorObserved) cancel()
        return
      }
      const rest = deadline - performance.now()
      if (rest <= 0) return
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, Math.min(RETRY_MS, rest))
        controller.signal.addEventListener('abort', finish, { once: true })
        if (controller.signal.aborted) finish()
      })
    }
  }
  const settled = Promise.all([
    probe(cdpPort, '/json/version', 'cdp'),
    probe(inspectPort, '/json/list', 'inspector')
  ]).then(cancel, cancel)
  return { cancel, settled }
}
