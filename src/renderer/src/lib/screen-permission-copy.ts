/**
 * screen-permission-copy.ts — one set of words for the Screen Recording diagnosis (M2-0429).
 *
 * The Listen mic-only note, the Bar chip, Settings and onboarding all describe the same diagnosis
 * (src/main/capture-permissions/diagnose.ts), so the copy lives here once. The rule this module keeps: a
 * grant that is on in System Settings but not in effect for this build is never answered with "open System
 * Settings" alone — that switch already shows on. It names which build or copy holds the grant and offers
 * Repair instead.
 */
import type { ScreenDiagnosis, ScreenRepairResult } from '@shared/screen-permission'
import { SCREEN_REPAIR_MANUAL_GUIDANCE } from '@shared/screen-capture'

export interface ScreenPermissionCopy {
  /** One or two sentences: what is wrong and the next step. */
  text: string
  /** Offer the one-click Repair (reset only Métis's own entry, then relaunch). */
  repair: boolean
  /** Offer "It's already on" (the user sees the switch on; record it and relaunch). */
  attest: boolean
  /** Offer a trip to the Screen Recording pane. */
  openSettings: boolean
  /** Offer a restart. */
  relaunch: boolean
}

const PANE = 'System Settings → Privacy & Security → Screen & System Audio Recording'

/** Why the permission is asked for, in the words onboarding and Settings both use. */
export const MEETING_AUDIO_SCREEN_LABEL = 'Meeting audio & screen'
export const MEETING_AUDIO_SCREEN_WHY = 'Needed to hear the other people in your calls, and to see your screen when you ask.'

/** Which build or copy the switch belongs to, as specifically as the diagnosis knows. */
export function screenGrantHolder(d: ScreenDiagnosis): string {
  if (d.grantedFor) return `Métis ${d.grantedFor.version}, an earlier build`
  if (d.duplicates.length === 1) return `another copy of Métis (${d.duplicates[0].path})`
  if (d.duplicates.length > 1) return `one of ${d.duplicates.length} other copies of Métis`
  return 'another copy or an earlier build of Métis'
}

const none: Omit<ScreenPermissionCopy, 'text'> = { repair: false, attest: false, openSettings: false, relaunch: false }

/** Copy for a macOS diagnosis, or null when nothing is wrong (granted) or there is no diagnosis. */
export function screenPermissionCopy(d: ScreenDiagnosis | null | undefined): ScreenPermissionCopy | null {
  if (!d) return null
  switch (d.state) {
    case 'granted':
      return null
    case 'not-asked':
      return {
        ...none,
        text: 'Métis needs Screen Recording to hear the other people in your calls. Allow it when macOS asks; the switch is in the top list, not “System Audio Recording Only”.'
      }
    case 'denied':
      return {
        ...none,
        openSettings: true,
        attest: true,
        text: `Screen Recording is off for Métis. Switch it on in ${PANE} (the top list), then restart Métis.`
      }
    case 'needs-relaunch':
      return { ...none, relaunch: true, text: 'Screen Recording is on. macOS applies it the next time Métis starts, so restart Métis.' }
    case 'restricted':
      return {
        ...none,
        text: 'Screen Recording is managed by your organization on this Mac, so Métis cannot turn it on. Ask your IT administrator.'
      }
    case 'not-effective': {
      if (d.reasons.includes('translocated')) {
        return {
          ...none,
          text: 'Métis is running from the temporary location macOS uses for apps opened in place, so its permission cannot stick. Move Métis to Applications, then open it from there.'
        }
      }
      const holder = screenGrantHolder(d)
      if (d.repairFailed) {
        return { ...none, openSettings: true, text: `macOS shows Métis as allowed, but that switch belongs to ${holder}. ${SCREEN_REPAIR_MANUAL_GUIDANCE}` }
      }
      return {
        ...none,
        repair: true,
        text: `macOS shows Métis as allowed, but that switch belongs to ${holder}. Repair resets only Métis’s Screen Recording entry and restarts Métis; then switch it on once more.`
      }
    }
  }
}

/** The Listen note when the other side of the call could not be captured on macOS. */
export function listenScreenNote(d: ScreenDiagnosis | null | undefined, micOnly: boolean): { note: string; repair: boolean } | null {
  const copy = screenPermissionCopy(d)
  if (!copy) return null
  const lead = micOnly ? 'Listening to your microphone only: the other side of the call needs Screen Recording.' : 'Could not capture the other side of the call.'
  return { note: `${lead} ${copy.text}`, repair: copy.repair }
}

/** The slice of Listen's state the mic-only note lives in (structural, so this module never imports listen). */
interface DegradedNote {
  side: 'them' | 'you'
  note: string
  permission: boolean
  repair?: boolean
}

/**
 * The Listen state with its missing-'them' note replaced by the diagnosis-backed one, keeping the sticky error
 * in step when it showed that note, and the remembered 'them' cause (`themRef`) with it. Returns `s` itself
 * when nothing changes, so a repeating permission poll never re-renders the tree.
 */
export function withDiagnosedThemNote<S extends { error: string | null; captureDegraded: DegradedNote | null }>(
  s: S,
  d: ScreenDiagnosis | null | undefined,
  themRef: { current: DegradedNote | null }
): S {
  const cur = s.captureDegraded
  const next = cur?.side === 'them' ? listenScreenNote(d, true) : null
  if (!cur || !next || (cur.note === next.note && !!cur.repair === next.repair)) return s
  const captureDegraded: DegradedNote = { ...cur, note: next.note, permission: true, repair: next.repair }
  themRef.current = captureDegraded
  return { ...s, error: s.error === cur.note ? next.note : s.error, captureDegraded }
}

/** Run Repair. On success main relaunches; on failure open the pane and hand back the manual guidance. */
export async function runScreenRepair(): Promise<ScreenRepairResult> {
  const result = await window.toto.repairScreenPermission().catch(
    (): ScreenRepairResult => ({ ok: false, reason: 'tccutil-failed', exitCode: null, guidance: SCREEN_REPAIR_MANUAL_GUIDANCE })
  )
  if (!result.ok && result.reason !== 'unsupported-platform') {
    void window.toto.openPermissionSettings('screenRecording').catch(() => {})
  }
  return result
}
