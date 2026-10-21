/**
 * OnboardingMicSetup.tsx — onboarding's Microphone row actions (C26, Apple HIG Privacy).
 *
 * Nothing asks when the Setup scene appears. The row first says why, then offers ONE button titled "Continue"
 * that raises the macOS prompt for the microphone only (a pre-alert never says "Allow" and never has a control
 * that skips the system alert). A denied microphone never re-prompts: macOS won't ask again, so the row opens
 * the Microphone privacy pane instead. A granted microphone needs no actions.
 */
import { useId, type MutableRefObject } from 'react'
import type { PlatformPermissions } from '@shared/screen-permission'
import { acquireInteractiveMic } from '../lib/input-mic-admission'
import { isWindows } from '../lib/keys'
import type { SetupRowState } from '../lib/onboarding-setup-rows'

const NOTE = 'text-[11px] leading-snug text-[color:var(--color-ink-3)]'
const SOFT_BUTTON =
  'no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25'

export function MicSetupActions({ state, onContinue }: { state: SetupRowState; onContinue: () => void }): JSX.Element | null {
  const whyId = useId()
  if (state === 'action') {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span id={whyId} className={NOTE}>
          Lets Métis hear your side of the call.
        </span>
        <button type="button" onClick={onContinue} aria-describedby={whyId} className={SOFT_BUTTON}>
          Continue
        </button>
      </div>
    )
  }
  if (state !== 'blocked') return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <span className={NOTE}>
        {isWindows
          ? 'Windows is blocking the microphone. Turn it back on in Privacy settings.'
          : "macOS won't ask again once you've said no. Turn it back on in Privacy settings."}
      </span>
      <button type="button" onClick={() => void window.toto.openPermissionSettings('microphone')} className={SOFT_BUTTON}>
        Open Microphone Settings
      </button>
    </div>
  )
}

/**
 * The Microphone row's Continue: the microphone prompt only, never Screen Recording. Windows: main's ask is a
 * macOS-only API, so the one thing that resolves consent there is a real getUserMedia from the renderer (a
 * rejection just means blocked; the status poll and the deep link handle that).
 */
export async function requestSetupMic(
  pending: MutableRefObject<AbortController | null>
): Promise<PlatformPermissions | null> {
  if (isWindows) {
    const controller = new AbortController()
    pending.current?.abort()
    pending.current = controller
    await acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
      .then(async ({ stream, admission }) => {
        stream.getTracks().forEach((track) => track.stop())
        await admission.release()
      })
      .catch(() => {})
      .finally(() => {
        if (pending.current === controller) pending.current = null
      })
  }
  return await window.toto.requestPermissionsUpfront('microphone').catch(() => null)
}
