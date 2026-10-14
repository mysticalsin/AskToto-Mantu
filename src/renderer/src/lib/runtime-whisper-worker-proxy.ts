type WhisperMessageEvent = (event: MessageEvent) => void
type WhisperErrorEvent = (event: ErrorEvent) => void

import { METIS_PACKAGE_PROFILE } from '@shared/package-profile'
import { ensureWhisperWorkerProfile } from './whisper-profile-admission'

export function createWhisperWorker(): Worker {
  if (METIS_PACKAGE_PROFILE === 'lean') return createRuntimeWhisperWorkerProxy()
  ensureWhisperWorkerProfile()
  return new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
}

/** Worker-shaped compatibility facade backed by the isolated, main-owned optional runtime host. */
export function createRuntimeWhisperWorkerProxy(): Worker {
  const requestId = crypto.randomUUID().replaceAll('-', '')
  const queued: { message: unknown; transfer: Transferable[] }[] = []
  let queuedBytes = 0
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
    queuedBytes = 0
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
      let snapshot: unknown
      let ownedTransfer: Transferable[] = []
      let size = 0
      if (
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        (message as { type?: unknown }).type === 'audio'
      ) {
        const audio = (message as { audio?: unknown }).audio
        const record = message as Record<string, unknown>
        if (
          Object.keys(record).sort().join(',') !==
            ['audio', 'partial', 'speaker', 'type']
              .filter((key) => key in record)
              .sort()
              .join(',') ||
          !(audio instanceof Float32Array) ||
          audio.length < 1 ||
          audio.length > 480_000 ||
          audio.byteOffset !== 0 ||
          audio.byteLength !== audio.buffer.byteLength ||
          (record.speaker !== 'you' && record.speaker !== 'them') ||
          (record.partial !== undefined && typeof record.partial !== 'boolean') ||
          (transfer.length > 0 && (transfer.length !== 1 || transfer[0] !== audio.buffer))
        ) {
          fail()
          return
        }
        if (transfer.length) {
          snapshot = structuredClone(message, { transfer: [audio.buffer] })
        } else {
          snapshot = { ...record, audio: new Float32Array(audio) }
        }
        const copied = (snapshot as { audio: Float32Array }).audio
        size = copied.byteLength
        ownedTransfer = [copied.buffer]
      } else {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          fail()
          return
        }
        const record = message as Record<string, unknown>
        if (record.type === 'init') {
          if (
            Object.keys(record).some(
              (key) => !['type', 'quality', 'language', 'resetFollow', 'bundled'].includes(key)
            ) ||
            (record.quality !== undefined && record.quality !== 'fast' && record.quality !== 'best') ||
            (record.language !== undefined &&
              (typeof record.language !== 'string' || !/^(?:auto|[a-z]{2,3})$/.test(record.language))) ||
            (record.resetFollow !== undefined && typeof record.resetFollow !== 'boolean') ||
            (record.bundled !== undefined && typeof record.bundled !== 'boolean')
          ) {
            fail()
            return
          }
        } else if (record.type === 'pinLanguage') {
          if (
            Object.keys(record).sort().join(',') !== 'language,type' ||
            typeof record.language !== 'string' ||
            !/^(?:auto|[a-z]{2,3})$/.test(record.language)
          ) {
            fail()
            return
          }
        } else {
          fail()
          return
        }
        snapshot = structuredClone(message)
      }
      if (port) port.postMessage(snapshot, ownedTransfer)
      else if (queued.length < 4 && queuedBytes + size <= 2_000_000) {
        queued.push({ message: snapshot, transfer: ownedTransfer })
        queuedBytes += size
      } else fail()
    },
    terminate(): void {
      if (closed) return
      closed = true
      queued.length = 0
      queuedBytes = 0
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
