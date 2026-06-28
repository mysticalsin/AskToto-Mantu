import { useState } from 'react'
import { ShieldCheck, ArrowRight } from 'lucide-react'
import type { PublicSettings, Profile } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { MantuLogo } from './MantuLogo'

/** Microsoft 4-square glyph (no lucide equivalent). */
function MsLogo({ size = 16 }: { size?: number }): JSX.Element {
  const g = size / 2 - 1
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="0" y="0" width={g} height={g} fill="#F25022" />
      <rect x={g + 2} y="0" width={g} height={g} fill="#7FBA00" />
      <rect x="0" y={g + 2} width={g} height={g} fill="#00A4EF" />
      <rect x={g + 2} y={g + 2} width={g} height={g} fill="#FFB900" />
    </svg>
  )
}

/**
 * 15-second onboarding: one screen. Consent + sign in, then go. Permissions are requested on first
 * use (mic/screen prompts), the API key + profile live in Settings. Microsoft (Azure AD) sign-in is
 * the intended gate — it ties the user to the Mantu domain and their Dust. See `signIn` wiring.
 */
export function Onboarding({
  settings,
  patch,
  onDone
}: {
  settings: PublicSettings
  saveKey?: (provider: ProviderId, k: string) => Promise<void>
  patch: (p: Partial<PublicSettings>) => void
  onDone: () => void
}): JSX.Element {
  const [recordingConsent, setRecordingConsent] = useState(settings.recordingConsent)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const finish = async (viaSso: boolean): Promise<void> => {
    if (!recordingConsent) {
      setErr('Please confirm the consent box to continue.')
      return
    }
    setErr('')
    setBusy(true)
    try {
      // Azure AD sign-in (domain-restricted) when configured; otherwise proceed.
      if (viaSso && window.toto.signIn) {
        const r = await window.toto.signIn()
        if (!r.ok) {
          setErr(r.error || 'Sign-in failed. Use a Mantu Microsoft account.')
          setBusy(false)
          return
        }
      }
      await patch({ onboardingDone: true, recordingConsent })
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not finish setup.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fade-up flex min-h-[300px] w-full flex-col items-center justify-center gap-6 rounded-3xl border border-white/10 bg-[linear-gradient(165deg,#3A0B6B_0%,#22084A_45%,#160030_100%)] px-6 py-10 text-center shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
      <MantuLogo size={210} />

      <div className="flex flex-col gap-2">
        <div className="font-ui text-[24px] font-semibold tracking-tight text-[color:var(--color-ink)]">
          Your invisible AI copilot.
        </div>
        <p className="mx-auto max-w-[480px] text-[13.5px] leading-relaxed text-[color:var(--color-ink-2)]">
          AskToto floats over everything, hears your calls, and tells you exactly what to say in
          meetings, interviews, and sales. Sign in to get started.
        </p>
      </div>

      <label className="no-drag flex max-w-[460px] cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] p-3 text-left hover:bg-white/[0.06]">
        <input
          type="checkbox"
          checked={recordingConsent}
          onChange={(e) => setRecordingConsent(e.target.checked)}
          className="no-drag mt-0.5 accent-[var(--color-accent)]"
        />
        <span className="text-[12px] leading-snug text-[color:var(--color-ink)]">
          I will inform other participants before recording. AskToto follows my company&apos;s policy
          and the law.
        </span>
      </label>

      {err && <div className="text-[12px] text-[color:var(--color-danger)]">{err}</div>}

      <div className="flex w-full max-w-[460px] flex-col gap-2">
        <button
          type="button"
          disabled={busy || !recordingConsent}
          onClick={() => finish(true)}
          className={[
            'no-drag focus-ring flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(180deg,#9A2BF0_0%,#7F00DA_100%)] px-4 py-2.5 text-[14px] font-semibold text-white shadow-[0_8px_24px_rgba(127,0,218,0.45)] hover:brightness-110',
            busy || !recordingConsent ? 'cursor-not-allowed opacity-50' : ''
          ].join(' ')}
        >
          <MsLogo size={16} /> Sign in with Microsoft
        </button>
        <button
          type="button"
          disabled={busy || !recordingConsent}
          onClick={() => finish(false)}
          className="no-drag focus-ring inline-flex items-center justify-center gap-1 rounded-xl px-4 py-2 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
        >
          Skip for now <ArrowRight size={12} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-3)]">
        <ShieldCheck size={12} className="text-[color:var(--color-accent)]" />
        Restricted to your Mantu Microsoft account · permissions are asked when you first Listen.
      </div>

      <div className="text-[10px] text-[color:var(--color-ink-3)]">
        Built by{' '}
        <a
          href="https://www.linkedin.com/in/tonywalteur/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-[color:var(--color-ink-2)]"
        >
          Tony Walteur
        </a>{' '}
        · Mantu
      </div>
    </div>
  )
}

/** Kept for type-compat with callers that pass a profile (unused in the fast flow). */
export type OnboardingProfile = Profile
