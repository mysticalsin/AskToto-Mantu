/**
 * OnboardingScreenSetup.tsx — onboarding's "Meeting audio & screen" row (M2-0429).
 *
 * Asked up front as a primary step, because it is what lets Métis hear the other side of a call. On macOS the
 * row follows the Screen Recording diagnosis, and it is green ONLY when a real loopback self-test produced a
 * live system-audio track: a 'granted' status alone has shown green for builds that could not capture. A
 * relaunch while setup is showing (ours after a grant, or macOS's own "Quit & Reopen") resumes setup, where
 * the self-test then runs.
 */
import { useEffect, useRef, useState } from 'react'
import type { PlatformPermissions } from '@shared/screen-permission'
import { isWindows } from '../lib/keys'
import { runLoopbackSelfTest } from '../lib/loopback-self-test'
import { MEETING_AUDIO_SCREEN_WHY, runScreenRepair, screenPermissionCopy } from '../lib/screen-permission-copy'

/** The real loopback self-test behind the row (lib/loopback-self-test). */
export type LoopbackCheck = 'idle' | 'running' | 'passed' | 'failed'
type ScreenRowState = 'checking' | 'ready' | 'action' | 'blocked' | 'restart'

function diagnosisState(perms: Pick<PlatformPermissions, 'screenRecording' | 'screenDiagnosis'>): string {
  return perms.screenDiagnosis?.state ?? (perms.screenRecording === 'granted' ? 'granted' : 'not-asked')
}

/** The row's state. Windows needs no grant (desktopCapturer captures without one), so it stays available. */
export function screenRowStatus(
  perms: Pick<PlatformPermissions, 'screenRecording' | 'screenDiagnosis'> | null | undefined,
  check: LoopbackCheck,
  windows: boolean
): { state: ScreenRowState; detail: string } {
  if (windows) return { state: 'ready', detail: 'available' }
  if (!perms) return { state: 'checking', detail: '' }
  switch (diagnosisState(perms)) {
    case 'granted':
      if (check === 'passed') return { state: 'ready', detail: 'meeting audio works' }
      if (check === 'failed') return { state: 'action', detail: 'meeting audio test failed' }
      return { state: 'checking', detail: 'testing meeting audio…' }
    case 'needs-relaunch':
      return { state: 'restart', detail: 'granted' }
    case 'denied':
      return { state: 'blocked', detail: 'permission denied' }
    case 'not-effective':
      return { state: 'blocked', detail: 'on in System Settings, but not for this copy of Métis' }
    case 'restricted':
      return { state: 'blocked', detail: 'managed by your organization' }
    default:
      return { state: 'action', detail: 'needs permission' }
  }
}

/** Survives the relaunch a fresh grant needs, so setup resumes where the user left it (then runs the test). */
export const ONBOARDING_RESUME_SETUP_KEY = 'metis.onboarding.resumeSetup'

/** Set while the setup scene is showing (a relaunch from there resumes it) and cleared on every other scene,
 *  so an ordinary relaunch never skips ahead. */
export function markOnboardingResumeSetup(storage: Pick<Storage, 'setItem' | 'removeItem'>, onSetup: boolean): void {
  try {
    if (onSetup) storage.setItem(ONBOARDING_RESUME_SETUP_KEY, '1')
    else storage.removeItem(ONBOARDING_RESUME_SETUP_KEY)
  } catch {
    /* storage unavailable: setup simply starts from the beginning */
  }
}

/** True when the previous process was relaunched from the setup scene; the marker is consumed either way. */
export function takeOnboardingResumeSetup(storage: Pick<Storage, 'getItem' | 'removeItem'>): boolean {
  try {
    const pending = storage.getItem(ONBOARDING_RESUME_SETUP_KEY) === '1'
    storage.removeItem(ONBOARDING_RESUME_SETUP_KEY)
    return pending
  } catch {
    return false
  }
}

// Read once per page load: a state initializer can run twice (StrictMode), and the marker is consumed.
let resumeSetupDecision: boolean | null = null
export function resumeSetupAtLoad(): boolean {
  if (resumeSetupDecision === null) {
    try {
      resumeSetupDecision = takeOnboardingResumeSetup(window.localStorage)
    } catch {
      resumeSetupDecision = false
    }
  }
  return resumeSetupDecision
}

/**
 * The row's live state: the latest permission snapshot, the self-test (run once the diagnosis says this build
 * can capture, i.e. after the grant and relaunch), and the primary ask. On macOS main's probe registers this
 * build and raises the system prompt; the fresh snapshot then drives the row (usually needs-relaunch).
 */
export function useScreenSetup(onSetup: boolean) {
  const [perms, setPerms] = useState<PlatformPermissions | null>(null)
  const [check, setCheck] = useState<LoopbackCheck>('idle')
  const checkRef = useRef<LoopbackCheck>('idle')
  checkRef.current = check
  useEffect(() => {
    try {
      markOnboardingResumeSetup(window.localStorage, onSetup)
    } catch {
      /* storage unavailable */
    }
  }, [onSetup])
  const captureReady = !!perms && diagnosisState(perms) === 'granted'
  useEffect(() => {
    if (!onSetup || isWindows || !captureReady || check !== 'idle') return
    setCheck('running')
    void runLoopbackSelfTest().then((ok) => setCheck(ok ? 'passed' : 'failed'))
  }, [onSetup, captureReady, check])
  const request = async (): Promise<void> => {
    const next = await window.toto.requestPermissionsUpfront().catch(() => null)
    if (next) setPerms(next)
  }
  return { perms, setPerms, check, checkRef, recheck: () => setCheck('idle'), request }
}

const SETUP_PRIMARY_BUTTON =
  'no-drag focus-ring rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-semibold text-white hover:brightness-110 disabled:opacity-60'
const SETUP_SOFT_BUTTON =
  'no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25'
const SETUP_LINK_BUTTON = 'no-drag focus-ring text-[11px] font-medium text-[color:var(--color-accent-2)] hover:underline'

/**
 * The row's why-copy and actions, from the diagnosis. Why-before-prompt, a primary ask while macOS has not
 * asked yet, Repair (never "open Settings" alone) when the switch already shows on for another copy or build,
 * and a retry when the real self-test heard nothing.
 */
export function ScreenSetupActions({
  perms,
  check,
  onRequest,
  onRecheck
}: {
  perms: PlatformPermissions | null
  check: LoopbackCheck
  onRequest: () => void
  onRecheck: () => void
}): JSX.Element | null {
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairGuidance, setRepairGuidance] = useState<string | null>(null)
  if (isWindows || !perms) return null
  const diagnosis = perms.screenDiagnosis
  const state = diagnosisState(perms)
  const note = (text: string): JSX.Element => (
    <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">{text}</span>
  )
  if (state === 'granted') {
    if (check !== 'failed') return null
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {note('Métis could not hear system audio in the test. Check that sound plays on this Mac, then try again.')}
        <button type="button" onClick={onRecheck} className={SETUP_SOFT_BUTTON}>
          Try again
        </button>
      </div>
    )
  }
  if (state === 'not-asked') {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {note(MEETING_AUDIO_SCREEN_WHY)}
        <button type="button" onClick={onRequest} className={SETUP_PRIMARY_BUTTON}>
          Allow meeting audio & screen
        </button>
      </div>
    )
  }
  const copy = screenPermissionCopy(diagnosis)
  if (!copy) return null
  const repair = (): void => {
    setRepairBusy(true)
    void runScreenRepair().then((result) => {
      // Success relaunches from main, and setup resumes here; only a failure comes back.
      if (!result.ok) setRepairGuidance(result.guidance || null)
      setRepairBusy(false)
    })
  }
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {note(repairGuidance ?? copy.text)}
      <div className="flex flex-wrap items-center gap-2">
        {copy.repair && !repairGuidance && (
          <button type="button" onClick={repair} disabled={repairBusy} className={SETUP_PRIMARY_BUTTON}>
            {repairBusy ? 'Repairing…' : 'Repair'}
          </button>
        )}
        {(copy.openSettings || repairGuidance) && (
          <button type="button" onClick={() => void window.toto.openPermissionSettings('screenRecording')} className={SETUP_SOFT_BUTTON}>
            Open Screen Recording Settings
          </button>
        )}
        {copy.attest && (
          <button type="button" onClick={() => void window.toto.attestScreenPermission().catch(() => {})} className={SETUP_LINK_BUTTON}>
            It’s already on
          </button>
        )}
      </div>
      {diagnosis && diagnosis.duplicates.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {diagnosis.duplicates.map((c) => (
            <li key={c.path} className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-ink-3)]">
              <span className="min-w-0 truncate" title={c.path}>
                {c.path}
                {c.version ? ` (${c.version})` : ''}
              </span>
              <button type="button" onClick={() => void window.toto.revealAppCopy(c.path).catch(() => {})} className={SETUP_LINK_BUTTON}>
                Show in Finder
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
