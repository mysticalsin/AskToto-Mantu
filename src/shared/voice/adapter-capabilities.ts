/**
 * Adapter capability declarations (G40, CAP-24): what each desktop adapter needs from the machine, declared once.
 *
 * `background` adapters finish their effect without Métis driving another app's input: they open an app or a URL, or
 * write through a scripting interface that works while another app is in front. `foreground-only` adapters need the
 * target app in front and synthesize input into it (a key press, later a click), so Métis must take control of the
 * foreground. That is a separate, explicit decision (src/main/tasks/focus-request.ts) and is releasable with Escape.
 *
 * Every id in the voice catalog must have a declaration; `validateAdapterCapabilities` is run at startup and by the
 * contract test. An id that has none is treated as foreground-only (fail closed). Pure: no I/O.
 */
import { DESKTOP_ADAPTER_IDS, type DesktopAdapterId } from '../desktop-actions'
import type { NativeHelperKind } from '../permission-helper'
import { classifyDesktopRequest, voicePlatformOf, type VoicePlatform } from './catalog'

export type AdapterControlMode = 'background' | 'foreground-only'
export type AdapterCapabilityPlatform = Extract<VoicePlatform, 'darwin' | 'win32'>

export interface AdapterPlatformCapability {
  mode: AdapterControlMode
  /** The macOS consents the adapter needs (G10 kinds). Windows has no per-app consent for these. */
  permissions: readonly NativeHelperKind[]
}

export interface AdapterCapability {
  /** Absent platform: the catalog cannot run the action there. */
  platforms: Partial<Record<AdapterCapabilityPlatform, AdapterPlatformCapability>>
  /** Named resources the action touches; a superset of what the task scheduler locks for any request of this id. */
  resources: readonly string[]
}

const BACKGROUND_NONE: AdapterPlatformCapability = { mode: 'background', permissions: [] }

export const ADAPTER_CAPABILITIES: Readonly<Record<DesktopAdapterId, AdapterCapability>> = {
  'desktop.open_notes': {
    platforms: { darwin: BACKGROUND_NONE, win32: BACKGROUND_NONE },
    resources: ['app:notes']
  },
  'desktop.create_note': {
    // AppleScript makes the note through Notes' scripting interface; no input is sent to any app.
    platforms: { darwin: { mode: 'background', permissions: ['automation'] }, win32: BACKGROUND_NONE },
    resources: ['app:notes']
  },
  'desktop.open_arc': {
    platforms: { darwin: BACKGROUND_NONE },
    resources: ['app:arc']
  },
  'desktop.google_search': {
    platforms: { darwin: BACKGROUND_NONE, win32: BACKGROUND_NONE },
    resources: ['app:arc', 'app:default-browser']
  },
  'desktop.open_x': {
    platforms: { darwin: BACKGROUND_NONE, win32: BACKGROUND_NONE },
    resources: ['app:arc', 'app:default-browser']
  },
  'desktop.photo_booth_capture': {
    platforms: {
      // Presses the shutter by sending a key press to Photo Booth, which must be in front.
      darwin: { mode: 'foreground-only', permissions: ['accessibility', 'automation'] },
      // Windows only opens Camera.
      win32: BACKGROUND_NONE
    },
    resources: ['app:photo-booth', 'device:camera']
  }
}

export function capabilityFor(
  id: DesktopAdapterId,
  platform: NodeJS.Platform | string
): AdapterPlatformCapability | null {
  const voicePlatform = voicePlatformOf(platform)
  if (voicePlatform === 'other') return null
  return ADAPTER_CAPABILITIES[id]?.platforms[voicePlatform] ?? null
}

/**
 * Whether running this adapter on this platform takes control of the foreground. An undeclared id answers yes.
 * A platform the adapter does not run on answers no: it refuses before touching anything.
 */
export function adapterNeedsForeground(id: DesktopAdapterId, platform: NodeJS.Platform | string): boolean {
  const declaration = ADAPTER_CAPABILITIES[id]
  if (!declaration) return true
  const voicePlatform = voicePlatformOf(platform)
  if (voicePlatform === 'other') return false
  const entry = declaration.platforms[voicePlatform]
  return entry ? entry.mode === 'foreground-only' : false
}

/** Problems with the declarations, empty when sound. Run at startup (a defect, not a user condition). */
export function validateAdapterCapabilities(
  ids: readonly DesktopAdapterId[] = DESKTOP_ADAPTER_IDS,
  table: Readonly<Record<DesktopAdapterId, AdapterCapability>> = ADAPTER_CAPABILITIES
): string[] {
  const problems: string[] = []
  const known = new Set<string>(ids)
  for (const id of ids) {
    const declaration = (table as Partial<Record<string, AdapterCapability>>)[id]
    if (!declaration) {
      problems.push(`${id}: no capability declaration`)
      continue
    }
    if (declaration.resources.length === 0 || new Set(declaration.resources).size !== declaration.resources.length) {
      problems.push(`${id}: resources must be a non-empty list without duplicates`)
    }
    for (const platform of ['darwin', 'win32'] as const) {
      const entry = declaration.platforms[platform]
      const runnable = classifyDesktopRequest({ id, args: {} } as never, platform) !== null
      if (runnable !== (entry !== undefined)) {
        problems.push(`${id}: ${platform} declaration disagrees with the catalog`)
      }
      if (!entry) continue
      if (platform === 'win32' && entry.permissions.length > 0) {
        problems.push(`${id}: win32 has no per-app consent to declare`)
      }
      if (entry.mode === 'foreground-only' && platform === 'darwin' && !entry.permissions.includes('accessibility')) {
        problems.push(`${id}: a foreground-only macOS adapter must declare accessibility`)
      }
    }
  }
  for (const id of Object.keys(table)) {
    if (!known.has(id)) problems.push(`${id}: declaration for an id that is not in the catalog`)
  }
  return problems
}
