/**
 * The one set of macOS permission and installation probes behind desktop actions (V03 adapters and V04 preflight).
 *
 * The adapters read them inside a dispatch as a last defense; the confirmation preflight reads the same ones before
 * a card is shown and again after Return, so the two can never disagree about what is granted. Only
 * `automationStatus` with `ask: true` can raise a system prompt, and only the preflight calls it that way, after a
 * person's Return and before any task exists. Every failure reads as unknown, never as granted.
 */
import { systemPreferences } from 'electron'
import { askAutomation, getBundleCopies, getTccStatus, type TccStatus } from './mac-helper'

export interface DesktopPermissionProbes {
  automationStatus(bundleId: string, options: { ask: boolean }): Promise<TccStatus | null>
  /** In-process Accessibility trust, read without the prompt flag. */
  accessibilityTrusted(): boolean
  /** true / false, or null when it cannot be determined (no helper). */
  appInstalled(bundleId: string): Promise<boolean | null>
}

export function createDesktopPermissionProbes(platform: NodeJS.Platform = process.platform): DesktopPermissionProbes {
  const mac = platform === 'darwin'
  return {
    automationStatus: (bundleId, { ask }) =>
      mac ? (ask ? askAutomation(bundleId) : getTccStatus('automation', bundleId)) : Promise.resolve(null),
    accessibilityTrusted: () => !mac || systemPreferences.isTrustedAccessibilityClient(false),
    appInstalled: async (bundleId) => {
      const copies = mac ? await getBundleCopies(bundleId) : null
      return copies === null ? null : copies.length > 0
    }
  }
}
