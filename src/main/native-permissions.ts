/**
 * native-permissions.ts — read-only probes for the macOS Accessibility, Input Monitoring and Automation consents
 * (G10), feeding the guided grant helper's re-read (ipc/permission-helper-ipc.ts).
 *
 * A probe here can never raise a system prompt (Apple HIG: ask only at the moment of need, on the person's own
 * Continue). Accessibility is read in-process with isTrustedAccessibilityClient(false); the prompt flag is never
 * true. Input Monitoring and Automation have no Electron API, so the Swift helper preflights them
 * (`tcc-status`), and no helper reads as 'unknown', never as granted. Everything OS-facing is injected, so the
 * mapping is unit-tested on any host.
 *
 * Windows and Linux have no per-app consent for any of the three: UI Automation and SendInput need none, so
 * they read 'not-required' and open no pane.
 *
 * Restart edge (ASSUMED, verify on an installed build): Accessibility and Automation apply to this process as
 * soon as they are on. Input Monitoring is read by a fresh helper process, so a grant is visible before the
 * running app can use it; the helper then offers its one Relaunch.
 */
import { AUTOMATION_TARGET, type HelperKind, type HelperStatus, type NativeHelperKind } from '@shared/permission-helper'
import { getTccStatus, type TccProbe, type TccStatus } from './mac-helper'

export type NativePermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'

export interface NativePermissionDeps {
  platform: NodeJS.Platform
  /** In-process Accessibility trust, read without the prompt flag. */
  isAccessibilityTrusted: () => boolean
  /** The helper's read-only preflight; null when there is no helper or it failed. */
  helperStatus: (probe: TccProbe, bundleId?: string) => Promise<TccStatus | null>
}

const NEEDS_RELAUNCH: Record<NativeHelperKind, boolean> = {
  accessibility: false,
  inputMonitoring: true,
  automation: false
}

export function isNativeKind(kind: unknown): kind is NativeHelperKind {
  return kind === 'accessibility' || kind === 'inputMonitoring' || kind === 'automation'
}

export async function nativePermissionStatus(
  kind: NativeHelperKind,
  deps: NativePermissionDeps
): Promise<NativePermissionStatus> {
  if (deps.platform !== 'darwin') return 'not-required'
  try {
    if (kind === 'accessibility') return deps.isAccessibilityTrusted() ? 'granted' : 'denied'
    const status =
      kind === 'inputMonitoring'
        ? await deps.helperStatus('listen-event')
        : await deps.helperStatus('automation', AUTOMATION_TARGET.bundleId)
    return status ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The permission helper's view: granted or not, and whether the grant waits for a relaunch. */
export async function nativeHelperStatus(kind: HelperKind, deps: NativePermissionDeps): Promise<HelperStatus> {
  if (!isNativeKind(kind)) return { granted: false, needsRelaunch: false }
  const status = await nativePermissionStatus(kind, deps)
  return { granted: status === 'granted', needsRelaunch: NEEDS_RELAUNCH[kind] }
}

/** The production wiring. `systemPreferences` is passed in so this module stays free of a runtime Electron import. */
export function createElectronNativeDeps(
  platform: NodeJS.Platform,
  systemPreferences: { isTrustedAccessibilityClient: (prompt: boolean) => boolean }
): NativePermissionDeps {
  return {
    platform,
    isAccessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
    helperStatus: (probe, bundleId) => getTccStatus(probe, bundleId)
  }
}
