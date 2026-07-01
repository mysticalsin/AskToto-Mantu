import { useEffect, useState } from 'react'
import {
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  Mic,
  Camera,
  Sparkles,
  Zap,
  FileText,
  Plus,
  LayoutGrid,
  Brain,
  Eye,
  Check,
  AlertCircle
} from 'lucide-react'
import type { PublicSettings, Profile, PlatformPermissions } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS } from '@shared/providers'
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

/** A single "here's what you can do" primer row — also used for the toolbar walkthrough slides. */
function ActionRow({ icon: Icon, label, hint, keys }: { icon: typeof Mic; label: string; hint: string; keys?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <Icon size={15} />
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--color-ink)]">
          {label}
          {keys && (
            <kbd className="rounded border border-[var(--color-hair-soft)] bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-ink-2)]">
              {keys}
            </kbd>
          )}
        </div>
        <div className="text-[11px] leading-snug text-[color:var(--color-ink-2)]">{hint}</div>
      </div>
    </div>
  )
}

/** A get-ready checklist line with a live status dot. */
function CheckRow({ ok, label, hint }: { ok: boolean; label: string; hint: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${
          ok ? 'bg-[var(--color-success)] text-white' : 'border border-[var(--color-hair-soft)] text-[color:var(--color-ink-3)]'
        }`}
      >
        {ok ? <Check size={11} /> : <AlertCircle size={11} />}
      </span>
      <div className="text-left">
        <span className="text-[12px] font-medium text-[color:var(--color-ink)]">{label}</span>
        {!ok && <span className="ml-1.5 text-[11px] text-[color:var(--color-ink-2)]">{hint}</span>}
      </div>
    </div>
  )
}

/** 5-dot progress indicator for the walkthrough slides (2-4 are the toolbar tour; 1 and 5 are the
 *  consent gate and readiness gate, which don't need it — they're the bookends, not part of the tour). */
function StepDots({ step }: { step: number }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`h-1.5 w-1.5 rounded-full ${n === step ? 'bg-[var(--color-accent)]' : 'bg-white/15'}`}
        />
      ))}
    </div>
  )
}

/** Shared Back/Next chrome for the toolbar-walkthrough slides (2-4). */
function WalkNav({ onBack, onNext, step }: { onBack: () => void; onNext: () => void; step: number }): JSX.Element {
  return (
    <div className="flex w-full max-w-[460px] items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        className="no-drag focus-ring inline-flex items-center gap-1 rounded-lg px-3 py-2 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
      >
        <ArrowLeft size={12} /> Back
      </button>
      <StepDots step={step} />
      <button
        type="button"
        onClick={onNext}
        className="no-drag focus-ring inline-flex items-center gap-1.5 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
      >
        Next <ArrowRight size={13} />
      </button>
    </div>
  )
}

/**
 * 5-slide onboarding. Slide 1: consent + sign in / continue (the legal + identity gate — required, not
 * skippable). Slides 2-4: a quick tour of every control on the toolbar, grouped by what they're for.
 * Slide 5: a live "get ready" checklist (key / mic / screen) + Get started (the functional readiness
 * gate). Slides 1 and 5 are load-bearing gates; 2-4 are pure walkthrough and can be skipped by Back/Next.
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
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1)
  const [perms, setPerms] = useState<PlatformPermissions | null>(null)

  // Pull live permission status when the final checklist appears (and refresh shortly after, since the
  // user may grant access in System Settings while this is open).
  useEffect(() => {
    if (step !== 5) return
    let alive = true
    const load = (): void => {
      void window.toto.getPermissions().then((p) => alive && setPerms(p))
    }
    load()
    const id = setInterval(load, 2500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [step])

  // Step 1 → 2: optional Azure sign-in, then start the toolbar walkthrough. onboardingDone is only set
  // on "Get started" (slide 5) — nothing here persists early.
  const advance = async (viaSso: boolean): Promise<void> => {
    if (!recordingConsent) {
      setErr('Please confirm the consent box to continue.')
      return
    }
    setErr('')
    setBusy(true)
    try {
      if (viaSso && window.toto.signIn) {
        const r = await window.toto.signIn()
        if (!r.ok) {
          setErr(r.error || 'Sign-in failed. Use a Mantu Microsoft account.')
          setBusy(false)
          return
        }
      }
      setStep(2)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not continue.')
    } finally {
      setBusy(false)
    }
  }

  const finish = (): void => {
    void patch({ onboardingDone: true, recordingConsent })
    onDone()
  }

  if (step === 2) {
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)]">Ask + capture</div>
        <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <ActionRow icon={Sparkles} label="Ask anything" keys="⌘⇧↵" hint="Type a question, or capture your screen for visual help." />
          <ActionRow icon={Camera} label="Capture screen" keys="⌘⇧S" hint="Get instant help with whatever you’re looking at." />
          <ActionRow icon={Zap} label="Quick actions" hint="One-tap chips: What to say next · Fact-check · Explain · Summarize." />
        </div>
        <WalkNav step={2} onBack={() => setStep(1)} onNext={() => setStep(3)} />
      </div>
    )
  }

  if (step === 3) {
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)]">Listen to your call</div>
        <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <ActionRow icon={Mic} label="Listen" hint="Transcribes both sides and suggests what to say, live." />
          <ActionRow icon={FileText} label="Live transcript" hint="Toggle the rolling transcript any time." />
          <ActionRow icon={Plus} label="New meeting" hint="Save the current call and start fresh." />
        </div>
        <WalkNav step={3} onBack={() => setStep(2)} onNext={() => setStep(4)} />
      </div>
    )
  }

  if (step === 4) {
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)]">Control how it answers</div>
        <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <ActionRow icon={LayoutGrid} label="Modes" hint="Pick the conversation: Interview, Meeting, Sales, and more." />
          <ActionRow icon={Brain} label="Deep thinking" hint="Force the strongest model. Glows purple when on." />
          <ActionRow icon={Eye} label="Private view" hint="Hide your notes from a shared screen." />
        </div>
        <p className="max-w-[460px] text-[11px] leading-snug text-[color:var(--color-ink-3)]">
          The Mantu logo opens Settings; minimize to a pill or collapse the panel any time.
        </p>
        <WalkNav step={4} onBack={() => setStep(3)} onNext={() => setStep(5)} />
      </div>
    )
  }

  if (step === 5) {
    const providerLabel = PROVIDERS[settings.provider]?.label ?? 'AI provider'
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <MantuLogo size={150} />
          <div className="font-ui text-[20px] font-semibold tracking-tight text-[color:var(--color-ink)]">
            You’re set. Let’s check you’re ready.
          </div>
        </div>

        <div className="flex w-full max-w-[460px] flex-col gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <div className="mb-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Get ready
          </div>
          <CheckRow ok={settings.providerReady} label={PROVIDERS[settings.provider]?.kind === 'cli' ? `${providerLabel} CLI connected` : `${providerLabel} API key`} hint="add it in Settings → AI" />
          <CheckRow ok={perms?.microphone === 'granted'} label="Microphone" hint="grant access when you first press Listen" />
          <CheckRow ok={perms?.screenRecording === 'granted'} label="Screen recording" hint="needed for the other side of calls + screen capture" />
        </div>

        <button
          type="button"
          onClick={finish}
          className="no-drag focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          Get started <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => setStep(4)}
          className="no-drag focus-ring text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
        >
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="fade-up flex min-h-[300px] w-full flex-col items-center justify-center gap-6 px-4 py-8 text-center">
      <MantuLogo size={210} />

      <div className="flex flex-col gap-2">
        <div className="font-ui text-[24px] font-semibold tracking-tight text-[color:var(--color-ink)]">
          Your on-device AI copilot.
        </div>
        <p className="mx-auto max-w-[480px] text-[13.5px] leading-relaxed text-[color:var(--color-ink-2)]">
          Transcription runs locally on your Mac. Audio never leaves your device. Answers are grounded in
          your meeting context and cited so you can verify them. Everyone on the call knows it&apos;s there.
        </p>
      </div>

      <div className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent-soft)] px-3 py-2 text-[12px] text-[color:var(--color-accent)]">
        <ShieldCheck size={12} />
        Audio is processed on your Mac and never uploaded.
      </div>

      <label className="no-drag flex max-w-[460px] cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] p-3 text-left hover:bg-white/[0.06]">
        <input
          type="checkbox"
          checked={recordingConsent}
          onChange={(e) => setRecordingConsent(e.target.checked)}
          className="no-drag mt-0.5 accent-[var(--color-accent)]"
        />
        <span className="text-[12px] leading-snug text-[color:var(--color-ink)]">
          I&apos;ll tell everyone on the call before I record, and follow my company&apos;s policy and the law.
        </span>
      </label>

      {err && <div className="text-[12px] text-[color:var(--color-danger)]">{err}</div>}

      <div className="flex w-full max-w-[460px] flex-col gap-2">
        <button
          type="button"
          disabled={busy || !recordingConsent}
          onClick={() => advance(true)}
          className={[
            'no-drag focus-ring flex items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:hover:brightness-100',
            busy || !recordingConsent ? 'cursor-not-allowed opacity-50' : ''
          ].join(' ')}
        >
          <MsLogo size={16} /> Sign in with Microsoft
        </button>
        <button
          type="button"
          disabled={busy || !recordingConsent}
          onClick={() => advance(false)}
          className="no-drag focus-ring inline-flex items-center justify-center gap-1 rounded-xl px-4 py-2 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-[color:var(--color-ink-3)]"
        >
          Continue without signing in <ArrowRight size={12} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-3)]">
        <ShieldCheck size={12} className="text-[color:var(--color-accent)]" />
        Restricted to your Mantu Microsoft account · permissions are requested the first time you Listen.
      </div>

      <div className="text-[10px] text-[color:var(--color-ink-3)]">
        Mantu · AskToto
      </div>
    </div>
  )
}

/** Kept for type-compat with callers that pass a profile (unused in the fast flow). */
export type OnboardingProfile = Profile
