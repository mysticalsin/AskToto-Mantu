/**
 * win-ax-helper.ts (G24): the typed gateway to resources/win-ax/metis-win-ax.ps1, the Windows twin of the macOS
 * `ax-focus-snapshot` / `ax-insert` helper (mac-ax-helper.ts). Same JSON shapes, same parsers, same client interface.
 *
 * Why a PowerShell script and not a binary: the app ships no native modules, UI Automation is available to Windows
 * PowerShell 5.1 (System.Windows.Automation), and SendInput is one P/Invoke. foreground-watcher.ts already runs
 * PowerShell the same way. A compiled helper would add a signing and packaging surface for a call that is not hot.
 *
 * Launch contract: the pinned absolute System32 powershell.exe (never a bare name, see win-security.ts), `-File` with
 * the shipped script and exactly one argv word. The dictated text and every other parameter are written to STDIN
 * (a command line is readable by any local process). Anything missing, slow or malformed degrades to null, which the
 * adapter reads as "unsupported" before a write and "uncertain" after one.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  axInsertRequestBody,
  parseAxFocusSnapshot,
  parseAxInsert,
  type AxHelperClient,
  type AxInsertRequest
} from './mac-ax-helper'
import { runHelperOnce } from './mac-helper'
import { WINDOWS_POWERSHELL } from './win-security'

/** Windows PowerShell start, Add-Type and one UI Automation walk; a cold machine needs seconds. */
const WIN_AX_SNAPSHOT_TIMEOUT_MS = 10_000
/** Modifier wait (1.5 s) + chunked send + a 0.6 s readback, plus start-up and slack. */
const WIN_AX_INSERT_TIMEOUT_MS = 20_000

export const WIN_AX_SCRIPT_RELATIVE = join('win-ax', 'metis-win-ax.ps1')

export interface WinAxLocator {
  platform?: NodeJS.Platform
  resourcesPath?: string
  exists?: (path: string) => boolean
}

/** The shipped script's absolute path, or null off Windows or when the packaged resource is missing. */
export function winAxScriptPath(locator: WinAxLocator = {}): string | null {
  if ((locator.platform ?? process.platform) !== 'win32') return null
  const resourcesPath = locator.resourcesPath ?? process.resourcesPath ?? ''
  if (!resourcesPath) return null
  const script = join(resourcesPath, WIN_AX_SCRIPT_RELATIVE)
  return (locator.exists ?? existsSync)(script) ? script : null
}

export function winAxHelperPresent(locator: WinAxLocator = {}): boolean {
  return winAxScriptPath(locator) !== null
}

function spawnSpec(command: 'ax-focus-snapshot' | 'ax-insert', locator: WinAxLocator = {}) {
  const script = winAxScriptPath(locator)
  if (script === null) return null
  return {
    command: WINDOWS_POWERSHELL,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, command]
  }
}

export const winAxFocusSnapshotSpawnSpec = (locator?: WinAxLocator) => spawnSpec('ax-focus-snapshot', locator)
/** The text is never part of this spec: it goes to stdin (see axInsertRequestBody). */
export const winAxInsertSpawnSpec = (locator?: WinAxLocator) => spawnSpec('ax-insert', locator)

export const winAxHelperClient: AxHelperClient = {
  snapshot: () => runHelperOnce(winAxFocusSnapshotSpawnSpec(), parseAxFocusSnapshot, WIN_AX_SNAPSHOT_TIMEOUT_MS),
  insert: (request: AxInsertRequest) =>
    runHelperOnce(winAxInsertSpawnSpec(), parseAxInsert, WIN_AX_INSERT_TIMEOUT_MS, axInsertRequestBody(request))
}
