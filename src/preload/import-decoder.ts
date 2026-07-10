import { contextBridge, ipcRenderer } from 'electron'

// This preload intentionally uses literal private channel names. Importing shared runtime code can split
// a sandboxed preload into chunks Electron cannot resolve; type safety lives at the main-process boundary.
const SOURCE_START = 'import-decoder:source-start'
const SOURCE_CHUNK = 'import-decoder:source-chunk'
const SOURCE_ACK = 'import-decoder:source-ack'
const CHUNK = 'import-decoder:chunk'
const COMPLETE = 'import-decoder:complete'
const FAILED = 'import-decoder:failed'
const READY = 'import-decoder:ready'

type Start = { jobId: string; skipThrough: number }
type SourceChunk = { jobId: string; bytes: Uint8Array; done: boolean }
type DecodedChunk = { jobId: string; seq: number; totalChunks: number; samples: Float32Array }

const api = {
  ready: (): void => ipcRenderer.send(READY),
  onStart: (callback: (payload: Start) => void): (() => void) => {
    const listener = (_event: unknown, payload: Start): void => callback(payload)
    ipcRenderer.on(SOURCE_START, listener)
    return () => ipcRenderer.removeListener(SOURCE_START, listener)
  },
  onSourceChunk: (callback: (payload: SourceChunk) => void): (() => void) => {
    const listener = (_event: unknown, payload: SourceChunk): void => callback(payload)
    ipcRenderer.on(SOURCE_CHUNK, listener)
    return () => ipcRenderer.removeListener(SOURCE_CHUNK, listener)
  },
  acknowledgeSource: (jobId: string): void => ipcRenderer.send(SOURCE_ACK, { jobId }),
  submitChunk: (payload: DecodedChunk): Promise<void> => ipcRenderer.invoke(CHUNK, payload),
  complete: (jobId: string): Promise<void> => ipcRenderer.invoke(COMPLETE, { jobId }),
  fail: (jobId: string, error: string): Promise<void> => ipcRenderer.invoke(FAILED, { jobId, error })
}

contextBridge.exposeInMainWorld('importDecoder', api)
