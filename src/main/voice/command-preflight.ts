/**
 * Preflight for a confirmed or proposed desktop action (V04, design section 5.1 and 11).
 *
 * It answers one question before anything is shown or dispatched: can this succeed? Signed in, not recording a
 * meeting, the target app installed, the macOS permission present. When it cannot, the person gets the honest
 * sentence instead of a card that would fail or, worse, a prompt that appears mid-dispatch and leaves an
 * uncertain effect. A check that cannot be answered (no helper) does not block: the adapter fails visibly.
 * Everything is injected; the production composition is in command-confirm-runtime.ts.
 */
import type { DesktopActionRequest } from '@shared/desktop-actions'
import type { MetisCommandNotice } from '@shared/metis-command-contract'
import type { CommandPreflightResult, CommandPreflightStage } from '../command-control'

export type AutomationStatus = 'granted' | 'denied' | 'unknown'

export interface CommandPreflightDeps {
  platform: NodeJS.Platform
  isAuthenticated(): boolean
  /** A meeting is being recorded: voice actions are paused (they would land in the call and its transcript). */
  isRecordingMeeting(): boolean
  /** true / false, or null when it cannot be determined. */
  appInstalled(bundleId: string): Promise<boolean | null>
  /** `ask` raises the system prompt and waits for the answer. Only ever true after Return, before dispatch. */
  automationStatus(bundleId: string, options: { ask: boolean }): Promise<AutomationStatus | null>
  accessibilityTrusted(): boolean
}

const NOTES = 'com.apple.Notes'
const SYSTEM_EVENTS = 'com.apple.systemevents'
const PHOTO_BOOTH = 'com.apple.PhotoBooth'
const ARC = 'company.thebrowser.Browser'

type MacRequirement = {
  app: { bundleId: string; missing: string }
  automation?: { bundleId: string; name: string }
  accessibility?: string
}

/** macOS requirements per action. Windows has no per-app consent for these, so it has none. */
const MAC_REQUIREMENTS: Partial<Record<DesktopActionRequest['id'], MacRequirement>> = {
  'desktop.create_note': {
    app: { bundleId: NOTES, missing: "Notes isn't installed." },
    automation: { bundleId: NOTES, name: 'Notes' }
  },
  'desktop.open_arc': {
    app: { bundleId: ARC, missing: "Arc isn't installed. Métis won't use another browser instead." }
  },
  'desktop.photo_booth_capture': {
    app: { bundleId: PHOTO_BOOTH, missing: "Photo Booth isn't installed." },
    automation: { bundleId: SYSTEM_EVENTS, name: 'System Events' },
    accessibility: 'To press the shutter in Photo Booth, Métis needs Accessibility.'
  }
}

const fail = (notice: MetisCommandNotice): CommandPreflightResult => ({ ok: false, notice })

export function createCommandPreflight(
  deps: CommandPreflightDeps
): (request: DesktopActionRequest, stage: CommandPreflightStage) => Promise<CommandPreflightResult> {
  return async (request, stage) => {
    if (!deps.isAuthenticated()) {
      return fail({ code: 'signed_out', copy: 'Sign in to Métis to use voice actions.' })
    }
    // A card already on screen is not retracted when a meeting starts (it is not a microphone), so the recording
    // check gates only a new proposal.
    if (stage === 'propose' && deps.isRecordingMeeting()) {
      return fail({ code: 'meeting_recording', copy: 'Voice actions are paused while Métis records a meeting.' })
    }
    const requirement = deps.platform === 'darwin' ? MAC_REQUIREMENTS[request.id] : undefined
    if (!requirement) return { ok: true }

    if ((await deps.appInstalled(requirement.app.bundleId)) === false) {
      return fail({ code: 'app_missing', copy: requirement.app.missing })
    }
    if (requirement.accessibility && !deps.accessibilityTrusted()) {
      return fail({ code: 'accessibility_needed', copy: requirement.accessibility, settingsKind: 'accessibility' })
    }
    if (requirement.automation) {
      const status = await deps.automationStatus(requirement.automation.bundleId, { ask: stage === 'confirm' })
      if (status === 'denied') {
        return fail({
          code: 'automation_denied',
          copy: `Métis isn't allowed to control ${requirement.automation.name}.`,
          settingsKind: 'automation'
        })
      }
    }
    return { ok: true }
  }
}
