/**
 * Métis 2.0 Cap 2 — register command-session IPC + singleton runtime.
 * Keeps index.ts thin. Pack HOLD. OAuth LAST.
 */

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { resolveOperatorBaseUrl, resolveOperatorCredential } from '@shared/operator'
import { createMetisCommandRuntime, type MetisCommandRuntime } from './metis-command-runtime'
import type { PublicSettings } from '@shared/ipc'

let runtime: MetisCommandRuntime | null = null

export function getMetisCommandRuntime(): MetisCommandRuntime | null {
  return runtime
}

export function ensureMetisCommandRuntime(opts: {
  getWindow: () => BrowserWindow | null
  getSettings: () => PublicSettings | { operatorUrl?: string; operatorLicenseToken?: string; operatorIngestSecret?: string }
  /** Optional: decisionProviders.jev from last heartbeat (Cap1). Default false = deterministic only. */
  jevEnabled?: () => boolean
}): MetisCommandRuntime {
  if (runtime) return runtime
  runtime = createMetisCommandRuntime({
    onState: (state) => {
      const w = opts.getWindow()
      w?.webContents.send(IPC.metisCommandState, {
        phase: state.phase,
        active: state.active,
        pillVisible: state.pillVisible,
        pillCopy: state.pillCopy,
        liveTranscript: state.liveTranscript,
        chime: state.chime
      })
    },
    jevEnabled: () => opts.jevEnabled?.() === true,
    operatorDecideAuth: () => {
      const s = opts.getSettings()
      const base = resolveOperatorBaseUrl(s)
      const secret = resolveOperatorCredential(s)
      if (!base || !secret) return null
      // Seat uses same license/HMAC material as ask/heartbeat — never a TypeSafe key.
      return { baseUrl: base, authorizationHeader: `Bearer ${secret}` }
    }
  })
  return runtime
}

export function registerMetisCommandIpc(opts: {
  assertMainWindow: (e: Electron.IpcMainInvokeEvent) => void
  getWindow: () => BrowserWindow | null
  getSettings: () => PublicSettings | { operatorUrl?: string; operatorLicenseToken?: string; operatorIngestSecret?: string }
  jevEnabled?: () => boolean
}): void {
  const rt = () => ensureMetisCommandRuntime(opts)

  ipcMain.handle(IPC.metisCommandStop, (e) => {
    opts.assertMainWindow(e)
    rt().stopLocal('escape')
    return { ok: true as const }
  })

  ipcMain.handle(IPC.metisCommandIngest, (e, payload: unknown) => {
    opts.assertMainWindow(e)
    const p = payload as { text?: unknown; channel?: unknown }
    const text = typeof p?.text === 'string' ? p.text : ''
    const channel =
      p?.channel === 'command' || p?.channel === 'always' || p?.channel === 'meeting'
        ? p.channel
        : 'meeting'
    if (text) rt().ingestTranscript(text, channel)
    return { ok: true as const }
  })
}

/** Feed finals from existing ASR — no new mic stack. Wake required before execute. */
export function ingestMetisCommandFromAsr(
  text: string,
  channel: 'meeting' | 'command' | 'always' = 'meeting'
): void {
  if (!runtime || !text.trim()) return
  runtime.ingestTranscript(text, channel)
}
