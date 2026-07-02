import { contextBridge, ipcRenderer } from 'electron'
import type { BrainRead, BrainStatus } from '@shared/brain'

/**
 * Preload for the Mantu Intelligence dashboard window — deliberately tiny. The dashboard is a
 * read-only visualization surface: it may read the brain and ask for a backfill, nothing else.
 * None of the overlay's privileged API (capture, keys, settings, transcripts) is exposed here.
 *
 * Channel names are string literals ON PURPOSE (mirroring IPC.brain* in src/shared/ipc.ts): importing
 * the zod-heavy @shared/ipc here would make Rollup split a chunk SHARED with the main preload — and a
 * sandboxed preload cannot require() secondary chunks, which silently breaks window.toto in the
 * overlay. Type-only imports (@shared/brain) are erased at compile time and are safe.
 */
const api = {
  getData: (): Promise<BrainRead> => ipcRenderer.invoke('brain:read'),
  getStatus: (): Promise<BrainStatus | null> => ipcRenderer.invoke('brain:status'),
  backfill: (): Promise<{ queued: number }> => ipcRenderer.invoke('brain:backfill')
}

export type IntelligenceApi = typeof api

contextBridge.exposeInMainWorld('intelligence', api)
