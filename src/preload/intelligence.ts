import { contextBridge, ipcRenderer } from 'electron'
import type { BrainRead, BrainStatus, EntityKind } from '@shared/brain'

/**
 * Preload for the Mantu Intelligence dashboard window — deliberately tiny. The dashboard is a
 * read-focused visualization surface: it may read the brain, request a guarded backfill, start the
 * Update Intelligence pass (local-first, API once), and accept a single already-`extracted` field
 * suggestion (dashboard accept/dismiss, deferred CRM pattern 3) — nothing else. None of the overlay's
 * privileged API (capture, keys, settings, transcripts) is exposed here. Never auto-send.
 *
 * Channel names are string literals ON PURPOSE (mirroring IPC.brain* in src/shared/ipc.ts): importing
 * the zod-heavy @shared/ipc here would make Rollup split a chunk SHARED with the main preload — and a
 * sandboxed preload cannot require() secondary chunks, which silently breaks window.toto in the
 * overlay. Type-only imports (@shared/brain) are erased at compile time and are safe.
 */
const api = {
  getData: (): Promise<BrainRead> => ipcRenderer.invoke('brain:read'),
  getStatus: (): Promise<BrainStatus | null> => ipcRenderer.invoke('brain:status'),
  backfill: (): Promise<{ queued: number; deferred?: 'no-provider'; preparing?: boolean }> => ipcRenderer.invoke('brain:backfill'),
  runPass: (): Promise<{
    queued: number
    deferred?: 'no-provider'
    preparing?: boolean
    error?: string
    upToDate?: boolean
  }> => ipcRenderer.invoke('brain:intelligencePass'),
  fieldDecision: (payload: {
    entityKind: EntityKind
    entityId: string
    field: string
    decision: 'accept' | 'dismiss'
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('brain:field-decision', payload)
}

contextBridge.exposeInMainWorld('intelligence', api)
