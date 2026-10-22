/**
 * The OS/app permission decision (G31), read through the G10 probes. It answers one question: has macOS allowed
 * Métis to do what this action needs? It never prompts (the probes are read-only), and it is independent of both
 * the user's approval and the plan: an approval cannot create an OS permission and an OS permission is not an
 * approval.
 *
 * Windows and Linux have no per-app consent for these actions, so they read 'not-required' without probing.
 * A probe that is absent, fails or cannot tell reads 'unknown', never 'granted'.
 */
import type { DesktopActionRequest, DesktopAdapterId } from '@shared/desktop-actions'

export type OsRequirement =
  | { readonly kind: 'accessibility' }
  | { readonly kind: 'automation'; readonly bundleId: string }

/** What each adapter needs on macOS. These mirror the consent checks inside desktop-adapters.ts. */
export const OS_REQUIREMENTS: Readonly<Partial<Record<DesktopAdapterId, readonly OsRequirement[]>>> = {
  'desktop.create_note': [{ kind: 'automation', bundleId: 'com.apple.Notes' }],
  'desktop.photo_booth_capture': [{ kind: 'accessibility' }, { kind: 'automation', bundleId: 'com.apple.systemevents' }]
}

/** Fixed labels for the refusal copy: never taken from the request. */
const AUTOMATION_TARGET_LABELS: Readonly<Record<string, string>> = {
  'com.apple.Notes': 'Notes',
  'com.apple.systemevents': 'System Events'
}

export type OsPermissionVerdict =
  | { status: 'granted' }
  | { status: 'not-required' }
  | { status: 'denied'; permission: OsRequirement['kind']; target: string }
  | { status: 'unknown'; permission: OsRequirement['kind'] }

export interface OsPermissionSeam {
  check(request: DesktopActionRequest): Promise<OsPermissionVerdict>
}

export interface OsPermissionProbes {
  platform: NodeJS.Platform | string
  /** In-process Accessibility trust, read without the prompt flag. */
  accessibilityTrusted?: () => boolean
  /** The helper's read-only Automation preflight. */
  automationStatus?: (bundleId: string) => Promise<'granted' | 'denied' | 'unknown'>
}

export function createOsPermissionSeam(probes: OsPermissionProbes): OsPermissionSeam {
  return {
    async check(request) {
      if (probes.platform !== 'darwin') return { status: 'not-required' }
      for (const requirement of OS_REQUIREMENTS[request.id] ?? []) {
        let status: 'granted' | 'denied' | 'unknown'
        try {
          if (requirement.kind === 'accessibility') {
            status = probes.accessibilityTrusted ? (probes.accessibilityTrusted() ? 'granted' : 'denied') : 'unknown'
          } else {
            status = (await probes.automationStatus?.(requirement.bundleId)) ?? 'unknown'
          }
        } catch {
          status = 'unknown'
        }
        if (status === 'denied') {
          const target =
            requirement.kind === 'accessibility'
              ? 'Accessibility'
              : (AUTOMATION_TARGET_LABELS[requirement.bundleId] ?? 'another app')
          return { status: 'denied', permission: requirement.kind, target }
        }
        if (status === 'unknown') return { status: 'unknown', permission: requirement.kind }
      }
      return { status: 'granted' }
    }
  }
}
