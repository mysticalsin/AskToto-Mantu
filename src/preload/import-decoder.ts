import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/contracts/channels'

type Start = { jobId: string; skipThrough: number }
type SourceChunk = { jobId: string; bytes: Uint8Array; done: boolean }
type DecodedChunk = { jobId: string; seq: number; totalChunks: number; samples: Float32Array }

const api = {
  ready: (): void => ipcRenderer.send(IPC.importDecoderReady),
  onStart: (callback: (payload: Start) => void): (() => void) => {
    const listener = (_event: unknown, payload: Start): void => callback(payload)
    ipcRenderer.on(IPC.importDecoderSourceStart, listener)
    return () => ipcRenderer.removeListener(IPC.importDecoderSourceStart, listener)
  },
  onSourceChunk: (callback: (payload: SourceChunk) => void): (() => void) => {
    const listener = (_event: unknown, payload: SourceChunk): void => callback(payload)
    ipcRenderer.on(IPC.importDecoderSourceChunk, listener)
    return () => ipcRenderer.removeListener(IPC.importDecoderSourceChunk, listener)
  },
  acknowledgeSource: (jobId: string): void => ipcRenderer.send(IPC.importDecoderSourceAck, { jobId }),
  submitChunk: (payload: DecodedChunk): Promise<void> => ipcRenderer.invoke(IPC.importDecoderChunk, payload),
  complete: (jobId: string): Promise<void> => ipcRenderer.invoke(IPC.importDecoderComplete, { jobId }),
  fail: (jobId: string, error: string): Promise<void> => ipcRenderer.invoke(IPC.importDecoderFailed, { jobId, error })
}

contextBridge.exposeInMainWorld('importDecoder', api)
