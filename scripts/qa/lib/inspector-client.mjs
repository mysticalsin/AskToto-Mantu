import WebSocket from 'ws'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (value, key) => Object.hasOwn(value, key)

function budget(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive finite timer budget`)
  }
  return value
}

function validMessage(message) {
  if (!record(message)) return false
  if (!owns(message, 'id')) {
    return (
      typeof message.method === 'string' &&
      message.method.length > 0 &&
      !owns(message, 'result') &&
      !owns(message, 'error') &&
      (!owns(message, 'params') || record(message.params))
    )
  }
  if (!Number.isSafeInteger(message.id) || message.id <= 0 || owns(message, 'method')) return false
  if (owns(message, 'result') === owns(message, 'error')) return false
  if (owns(message, 'error')) {
    return record(message.error) && Number.isInteger(message.error.code) && typeof message.error.message === 'string'
  }
  if (!record(message.result)) return false
  if (!owns(message.result, 'exceptionDetails')) return true
  const details = message.result.exceptionDetails
  return (
    record(details) &&
    typeof details.text === 'string' &&
    (!owns(details, 'exception') ||
      (record(details.exception) &&
        (!owns(details.exception, 'description') || typeof details.exception.description === 'string')))
  )
}

/**
 * Bounded CDP transport. `evaluate` deliberately does not use awaitPromise: Electron 43 can collect
 * awaited wrappers for synchronous values. Async callers use send with an explicitly pinned expression.
 */
export async function inspectorClient(wsUrl, options = {}) {
  const connectMs = budget(options.connectTimeoutMs ?? 10_000, 'connectTimeoutMs')
  const requestMs = budget(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs')
  const closeMs = budget(options.closeTimeoutMs ?? 1_000, 'closeTimeoutMs')
  const { signal } = options
  if (
    signal !== undefined &&
    (typeof signal?.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError('signal must be an AbortSignal')
  }
  if (signal?.aborted) throw new Error('main-process inspector aborted')

  let state = 'connecting'
  let failure = null
  let nextId = 1
  let connectTimer
  let closeTimer
  let closePromise
  let resolveClose
  let rejectClose
  let resolveConnection
  let rejectConnection
  const pending = new Map()
  const connected = new Promise((resolve, reject) => {
    resolveConnection = resolve
    rejectConnection = reject
  })
  const socket = new WebSocket(wsUrl)

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  function clearLifecycleTimers() {
    clearTimeout(connectTimer)
    clearTimeout(closeTimer)
    connectTimer = undefined
    closeTimer = undefined
  }

  function fail(error) {
    if (failure) return
    failure = error
    state = 'failed'
    clearLifecycleTimers()
    signal?.removeEventListener('abort', onAbort)
    rejectConnection(error)
    rejectPending(error)
    rejectClose?.(error)
    // CONNECTING termination emits error and close asynchronously. Keep the error listener installed.
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }

  function onAbort() {
    fail(new Error('main-process inspector aborted'))
  }

  function onMessage(data, isBinary) {
    if (state !== 'open') return
    let message
    try {
      if (isBinary) throw new Error('binary frame')
      message = JSON.parse(data.toString())
      if (!validMessage(message)) throw new Error('invalid response shape')
    } catch {
      fail(new Error('main-process inspector received an invalid CDP message'))
      return
    }
    if (!owns(message, 'id')) return
    const request = pending.get(message.id)
    if (!request) return // Valid late replies and unsolicited events cannot settle a request twice.
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) {
      request.reject(new Error(message.error.message))
    } else if (message.result.exceptionDetails) {
      const details = message.result.exceptionDetails
      request.reject(new Error(details.exception?.description ?? details.text))
    } else {
      request.resolve(message.result)
    }
  }

  socket.once('open', () => {
    if (state !== 'connecting') return
    clearTimeout(connectTimer)
    connectTimer = undefined
    state = 'open'
    resolveConnection()
  })
  socket.on('message', onMessage)
  socket.on('error', () => fail(new Error('main-process inspector socket failed')))
  socket.once('close', (code) => {
    clearLifecycleTimers()
    signal?.removeEventListener('abort', onAbort)
    socket.off('message', onMessage)
    if (failure) return
    // 1005 is a received empty close frame; 1006 is an abnormal connection loss, never graceful.
    if (state === 'closing' && (code === 1000 || code === 1005)) {
      state = 'closed'
      resolveClose()
    } else {
      fail(new Error(`main-process inspector socket closed unexpectedly (${code})`))
    }
  })
  connectTimer = setTimeout(() => fail(new Error('main-process inspector connection timed out')), connectMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  await connected
  if (failure) throw failure

  const send = async (method, params, callOptions = {}) => {
    const timeoutMs = budget(callOptions.timeoutMs ?? requestMs, 'timeoutMs')
    if (state !== 'open') throw failure ?? new Error('main-process inspector is closing or closed')
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`main-process ${method} timed out`)), timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) fail(new Error('main-process inspector send failed'))
        })
      } catch {
        fail(new Error('main-process inspector send failed'))
      }
    })
  }
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value
  const collectGarbage = async () => {
    await send('HeapProfiler.collectGarbage')
    return true
  }
  const close = () => {
    if (closePromise) return closePromise
    if (failure) {
      closePromise = Promise.reject(failure)
      return closePromise
    }
    closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve
      rejectClose = reject
    })
    state = 'closing'
    rejectPending(new Error('main-process inspector is closing'))
    closeTimer = setTimeout(() => fail(new Error('main-process inspector close timed out')), closeMs)
    try {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('socket is not open')
      socket.close(1000)
    } catch {
      fail(new Error('main-process inspector could not close gracefully'))
    }
    return closePromise
  }
  return { send, evaluate, collectGarbage, close }
}
