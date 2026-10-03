import { contextBridge, ipcRenderer } from 'electron'
import type { BrainRead, BrainStatus, EntityKind } from '@shared/brain'
import { IPC } from '@shared/contracts/channels'

/**
 * Preload for the Mantu Intelligence dashboard window — deliberately tiny. The dashboard is a
 * read-focused visualization surface: it may read the brain, request a guarded backfill, start the
 * Update Intelligence pass (local-first, API once), and accept a single already-`extracted` field
 * suggestion (dashboard accept/dismiss, deferred CRM pattern 3) — nothing else. None of the overlay's
 * privileged API (capture, keys, settings, transcripts) is exposed here. Never auto-send.
 *
 * Import only the zod-free channel contract here. Pulling @shared/ipc into a sandboxed preload can make
 * Rollup split a secondary chunk that Electron cannot require from the preload.
 */
const api = {
  getData: (): Promise<BrainRead> => ipcRenderer.invoke(IPC.brainRead),
  getStatus: (): Promise<BrainStatus | null> => ipcRenderer.invoke(IPC.brainStatus),
  backfill: (): Promise<{
    queued: number
    deferred?: 'no-provider'
    preparing?: boolean
    error?: string
    recapped?: number
    upToDate?: boolean
    lastIndexedAt?: number
  }> => ipcRenderer.invoke(IPC.brainBackfill),
  runPass: (): Promise<{
    queued: number
    deferred?: 'no-provider'
    preparing?: boolean
    error?: string
    upToDate?: boolean
  }> => ipcRenderer.invoke(IPC.brainIntelligencePass),
  fieldDecision: (payload: {
    entityKind: EntityKind
    entityId: string
    field: string
    decision: 'accept' | 'dismiss'
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.brainFieldDecision, payload)
}

contextBridge.exposeInMainWorld('intelligence', api)
