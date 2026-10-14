type WhisperMessageEvent = (event: MessageEvent) => void
type WhisperErrorEvent = (event: ErrorEvent) => void

/** Worker-shaped compatibility facade backed by the isolated, main-owned optional runtime host. */
export function createRuntimeWhisperWorkerProxy(): Worker {
  const requestId = crypto.randomUUID().replaceAll('-', '')
  const queued: { message: unknown; transfer: Transferable[] }[] = []
  let port: MessagePort | null = null
  let closed = false
  let onmessage: WhisperMessageEvent | null = null
  let onerror: WhisperErrorEvent | null = null

  const fail = (): void => {
    if (closed) return
    const callback = onerror
    if (callback) callback(new ErrorEvent('error', { message: 'Offline speech runtime unavailable.' }))
  }
  const attach = (candidate: MessagePort): void => {
    if (closed || port) {
      candidate.close()
      return
    }
    port = candidate
    port.onmessage = (event: MessageEvent): void => {
      if (closed) return
      onmessage?.(new MessageEvent('message', { data: event.data }))
    }
    port.onmessageerror = fail
    port.start()
    for (const entry of queued.splice(0)) port.postMessage(entry.message, entry.transfer)
  }
  const onWindowMessage = (event: MessageEvent): void => {
    if (
      event.source !== window ||
      event.data?.type !== 'metis-runtime-worker-port' ||
      event.data?.requestId !== requestId ||
      event.ports.length !== 1
    )
      return
    attach(event.ports[0])
  }
  window.addEventListener('message', onWindowMessage)

  void window.toto
    .runtimeWhisperWorkerOpen(requestId)
    .then((result) => {
      if (!result.ok || result.requestId !== requestId) {
        fail()
        return
      }
      if (closed) void window.toto.runtimeWhisperWorkerClose(requestId)
    })
    .catch(() => {
      fail()
    })

  const worker = {
    onmessage: null as WhisperMessageEvent | null,
    onerror: null as WhisperErrorEvent | null,
    postMessage(message: unknown, transfer: Transferable[] = []): void {
      if (closed) return
      if (port) port.postMessage(message, transfer)
      else if (queued.length < 64) queued.push({ message, transfer })
      else fail()
    },
    terminate(): void {
      if (closed) return
      closed = true
      queued.length = 0
      window.removeEventListener('message', onWindowMessage)
      port?.close()
      port = null
      // This invokes the main-owned renderer exit barrier; the lease is retained there until Electron
      // reports the isolated host renderer process has actually exited.
      void window.toto.runtimeWhisperWorkerClose(requestId).catch(() => {})
    }
  }
  Object.defineProperties(worker, {
    onmessage: {
      get: () => onmessage,
      set: (value: WhisperMessageEvent | null) => {
        onmessage = value
      }
    },
    onerror: {
      get: () => onerror,
      set: (value: WhisperErrorEvent | null) => {
        onerror = value
      }
    }
  })
  return worker as unknown as Worker
}
