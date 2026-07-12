import { useEffect, useRef, useState } from 'react'
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
  AlertCircle,
  Terminal,
  KeyRound,
  Building2
} from 'lucide-react'
import type { PublicSettings, Profile, PlatformPermissions } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS } from '@shared/providers'
import { MetisMark } from './MetisMark'
import { accelLabel, isWindows } from '../lib/keys'

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

/** One selectable "how to power Métis" path on the provider-choice slide. A plain-language card the
 *  user taps to route themselves — no jargon, no key required to read it. */
function ProviderOption({
  icon: Icon,
  title,
  badge,
  desc,
  onClick
}: {
  icon: typeof Mic
  title: string
  badge?: string
  desc: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="no-drag focus-ring group flex items-start gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3.5 text-left transition-colors hover:border-[var(--color-accent)] hover:bg-white/[0.05]"
    >
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <Icon size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-[color:var(--color-ink)]">{title}</span>
          {badge && (
            <span className="rounded-full bg-[var(--color-success)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
              {badge}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-[color:var(--color-ink-2)]">{desc}</div>
      </div>
      <ArrowRight size={15} className="mt-1 shrink-0 text-[color:var(--color-ink-3)] group-hover:text-[color:var(--color-accent)]" />
    </button>
  )
}

/** A get-ready checklist line with a live status dot. `onFix` renders an inline "Open System Settings"
 *  link — only meaningful when the OS has recorded an explicit Deny (see the `denied` prop): on 'unknown'
 *  the right move is to just trigger the permission prompt via Listen, not send the user to Settings, and
 *  on 'granted' there's nothing to fix. */
function CheckRow({
  ok,
  denied,
  label,
  hint,
  note,
  onFix,
  fixLabel
}: {
  ok: boolean
  denied?: boolean
  label: string
  hint: string
  /** Neutral copy shown even when `ok` is true (e.g. Windows' "we'll ask you later" note). */
  note?: string
  onFix?: () => void
  /** Custom text for the fix link. Its presence also unlocks the link without requiring `denied` — used
   *  by the provider/API-key row, which has no OS-permission "denied" concept to gate on. */
  fixLabel?: string
}): JSX.Element {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg ${
        ok ? '' : 'border border-[var(--color-warn,#fac775)]/30 bg-[var(--color-warn,#fac775)]/10 p-2'
      }`}
    >
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${
          ok ? 'bg-[var(--color-success)] text-white' : 'bg-[var(--color-warn,#fac775)] text-white'
        }`}
      >
        {ok ? <Check size={11} /> : <AlertCircle size={11} />}
      </span>
      <div className="text-left">
        <span className="text-[12px] font-medium text-[color:var(--color-ink)]">{label}</span>
        {ok && note && <span className="ml-1.5 text-[11px] text-[color:var(--color-ink-2)]">{note}</span>}
        {!ok && <span className="ml-1.5 text-[11px] text-[color:var(--color-ink-2)]">{hint}</span>}
        {!ok && onFix && (denied || fixLabel) && (
          <button
            type="button"
            onClick={onFix}
            className="no-drag focus-ring ml-1.5 text-[11px] font-medium text-[color:var(--color-accent-2)] hover:underline"
          >
            {fixLabel ?? 'Open System Settings'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 5-dot progress indicator for the walkthrough + provider-choice slides (2-4 are the toolbar tour,
 *  5 is the provider picker; 1 and 6 are the consent gate and readiness gate, which don't need it since
 *  they're the bookends, not part of the countable sequence). */
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
 * 6-slide onboarding. Slide 1: consent + sign in / continue (the legal + identity gate, required, not
 * skippable). Slides 2-4: a quick tour of every control on the toolbar, grouped by what they're for.
 * Slide 5: pick how Métis answers (CLI / API key / Dust), part of the same countable sequence as 2-4.
 * Slide 6: a live "get ready" checklist (provider / mic / screen) + Get started (the functional readiness
 * gate). Slides 1 and 6 are load-bearing gates; 2-5 are walkthrough/choice and can be skipped by Back/Next.
 */
export function Onboarding({
  settings,
  patch,
  onDone,
  onOpenAiSettings
}: {
  settings: PublicSettings
  saveKey?: (provider: ProviderId, k: string) => Promise<void>
  // Real impl (state.ts) returns Promise<void> and awaits disk persistence; typed void to match the
  // Settings prop contract. `await patch(...)` still waits for the write before finish() calls onDone.
  patch: (p: Partial<PublicSettings>) => void
  onDone: () => void
  /** Optional: opens Settings -> AI in place, wired onto the provider/API-key readiness row. Parent
   *  wiring is added separately; the row simply has no click-through fix when this is left undefined. */
  onOpenAiSettings?: () => void
}): JSX.Element {
  const [recordingConsent, setRecordingConsent] = useState(settings.recordingConsent)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [finishErr, setFinishErr] = useState('')
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1)
  const [perms, setPerms] = useState<PlatformPermissions | null>(null)
  // Step 5's "An API key" card expands in place to name the actual providers instead of assuming
  // Anthropic — closes again if the user backs out of step 5 entirely.
  const [showApiPicker, setShowApiPicker] = useState(false)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  // Windows has no OS consent dialog for desktop apps — the mic toggle only becomes "determined" (from
  // this app's perspective) after it actually attempts a capture once. Fired at most once per mount.
  const micProbeFiredRef = useRef(false)

  // Move focus to the new step's heading on every transition so screen readers announce it instead of
  // silently dropping focus to <body>.
  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  // When the final checklist appears, first TRIGGER the OS permission prompts for anything still
  // missing (mic prompt + Screen Recording TCC registration; main sequences them) so the user grants
  // everything here instead of mid-first-meeting — then poll live status, since granting Screen
  // Recording happens in System Settings while this stays open.
  useEffect(() => {
    if (step !== 6) return
    let alive = true
    // Windows never surfaces an OS consent dialog, so getPlatformPermissions() stays 'unknown' forever
    // unless something actually calls getUserMedia. Do that once here, then let the existing poll below
    // pick up whatever the OS ends up reporting. A rejection just means blocked — the status/fix-button
    // flow already handles that — so it's swallowed, never an unhandled rejection.
    const probeWindowsMicIfNeeded = (p: PlatformPermissions): void => {
      if (!isWindows || micProbeFiredRef.current || p.microphone !== 'unknown') return
      micProbeFiredRef.current = true
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => stream.getTracks().forEach((t) => t.stop()))
        .catch(() => {})
    }
    const load = (): void => {
      void window.toto.getPermissions().then((p) => {
        if (!alive) return
        setPerms(p)
        probeWindowsMicIfNeeded(p)
      })
    }
    void window.toto
      .requestPermissionsUpfront()
      .then((p) => {
        if (!alive) return
        setPerms(p)
        probeWindowsMicIfNeeded(p)
      })
      .catch(load)
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

  const finish = async (): Promise<void> => {
    setFinishErr('')
    try {
      await patch({ onboardingDone: true, onboardingDoneAt: Date.now(), recordingConsent })
      onDone()
    } catch (e) {
      setFinishErr(`Couldn't save your setup. ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (step === 2) {
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div
          ref={headingRef}
          tabIndex={-1}
          className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
        >
          Ask + capture
        </div>
        <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <ActionRow icon={Sparkles} label="Ask anything" keys={accelLabel('CommandOrControl+Shift+Return')} hint="Type a question, or capture your screen for visual help." />
          <ActionRow icon={Camera} label="Capture screen" keys={accelLabel('CommandOrControl+Shift+S')} hint="Get instant help with whatever you’re looking at." />
          <ActionRow icon={Zap} label="Quick actions" hint="One-tap chips: What to say next · Fact-check · Explain · Summarize screen." />
        </div>
        {/* Invisible placeholder matching step 4's caption line, so WalkNav sits at the same height on
            every slide instead of jumping only when the real caption is present. */}
        <p className="invisible max-w-[460px] text-[11px] leading-snug text-[color:var(--color-ink-3)]" aria-hidden="true">
          The Métis mark opens Settings; minimize to a pill or collapse the panel any time.
        </p>
        <WalkNav step={2} onBack={() => setStep(1)} onNext={() => setStep(3)} />
      </div>
    )
  }

  if (step === 3) {
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div
          ref={headingRef}
          tabIndex={-1}
          className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
        >
          Listen to your call
        </div>
        <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <ActionRow icon={Mic} label="Listen" hint="Transcribes both sides and suggests what to say, live." />
          <ActionRow icon={FileText} label="Live transcript" hint="Toggle the rolling transcript any time." />
          <ActionRow icon={Plus} label="New meeting" hint="Save the current call and start fresh." />
        </div>
        {/* Invisible placeholder matching step 4's caption line, so WalkNav sits at the same height on
            every slide instead of jumping only when the real caption is present. */}
        <p className="invisible max-w-[460px] text-[11px] leading-snug text-[color:var(--color-ink-3)]" aria-hidden="true">
          The Métis mark opens Settings; minimize to a pill or collapse the panel any time.
        </p>
        <WalkNav step={3} onBack={() => setStep(2)} onNext={() => setStep(4)} />
      </div>
    )
  }

  if (step === 4) {
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div
          ref={headingRef}
          tabIndex={-1}
          className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
        >
          Control how it answers
        </div>
        <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <ActionRow icon={LayoutGrid} label="Modes" hint="Pick the conversation: Interview, Meeting, Sales, and more." />
          <ActionRow icon={Brain} label="Deep thinking" hint="Force the strongest model. Rainbow ring shows when on." />
          <ActionRow icon={Eye} label="Show / hide" hint="Toggle whether the Métis window appears on a screen you share or record. Hidden by default." />
        </div>
        <p className="max-w-[460px] text-[11px] leading-snug text-[color:var(--color-ink-3)]">
          The Métis mark opens Settings; minimize to a pill or collapse the panel any time.
        </p>
        <WalkNav step={4} onBack={() => setStep(3)} onNext={() => setStep(5)} />
      </div>
    )
  }

  if (step === 5) {
    // Route the user to a provider in plain language, then let the readiness step (6) confirm setup.
    // Picking a path just sets the active provider (Tony's routing: an API key -> Anthropic/Claude, a
    // Dust team -> Dust, an installed CLI -> Claude Code). "Decide later" is honoured — recording and
    // transcripts never need a key, so nobody is blocked here.
    const choose = (provider: ProviderId): void => {
      patch({ provider })
      setStep(6)
    }
    // "Claude Code or Codex" is one tile for two different CLIs, so detect which one is actually on
    // the machine instead of always assuming Claude Code (otherwise a Codex-only install lands on the
    // wrong provider and the next screen shows it as not connected).
    const chooseCli = async (): Promise<void> => {
      const claude = await window.toto.cliDetect('claude-cli')
      if (claude.ok) return choose('claude-cli')
      const codex = await window.toto.cliDetect('codex-cli')
      choose(codex.ok ? 'codex-cli' : 'claude-cli')
    }
    // "Mantu Dust" isn't just a preference — kick off the one-click setup right here so onboarding ends
    // CONNECTED, not just with Dust selected. Import an existing Dust CLI session, or auto-run the
    // installer + `dust login` if there's none; the main-process poll then connects on its own and the
    // readiness step reflects it. Cross-platform. If it can't run, the user still lands on step 6 and can
    // finish in Settings — no dead-end.
    const chooseDust = async (): Promise<void> => {
      choose('dust')
      const imported = await window.toto.dustImportCli()
      if (!imported.ok) void window.toto.dustSetupCli()
    }
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <div
            ref={headingRef}
            tabIndex={-1}
            className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
          >
            How should Métis answer you?
          </div>
          <p className="max-w-[460px] text-[12px] leading-snug text-[color:var(--color-ink-2)]">
            Transcription is always free and runs on your device. To get live answers, pick one way to
            connect the AI. You can change this any time in Settings.
          </p>
        </div>

        <div className="flex w-full max-w-[460px] flex-col gap-2.5">
          <ProviderOption
            icon={Terminal}
            title="Claude Code or Codex"
            badge="No key needed"
            desc="Already use Claude Code or Codex in your terminal? Connect it. Nothing extra to pay, nothing to paste."
            onClick={() => void chooseCli()}
          />
          {showApiPicker ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3.5 text-left">
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <KeyRound size={17} />
                </div>
                <span className="text-[13.5px] font-medium text-[color:var(--color-ink)]">Which provider?</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(['anthropic', 'openai', 'nvidia', 'minimax'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => choose(id)}
                    className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] px-2.5 py-1.5 text-left text-[12.5px] font-medium text-[color:var(--color-ink)] transition-colors hover:border-[var(--color-accent)] hover:bg-white/[0.05]"
                  >
                    {PROVIDERS[id].label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => choose('anthropic')}
                className="no-drag focus-ring text-left text-[11.5px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
              >
                Something else (DeepSeek, Qwen, Mistral, and more). Pick it in Settings
              </button>
            </div>
          ) : (
            <ProviderOption
              icon={KeyRound}
              title="An API key"
              desc="Claude, GPT, Grok, Kimi, and more. Paste your key and you're set. You pay your provider directly."
              onClick={() => setShowApiPicker(true)}
            />
          )}
          <ProviderOption
            icon={Building2}
            title="Mantu Dust"
            badge="One-click setup"
            desc="Use Mantu's shared Dust workspace. Installs and signs you in automatically. No key to paste."
            onClick={() => void chooseDust()}
          />
        </div>

        <button
          type="button"
          onClick={() => setStep(6)}
          className="no-drag focus-ring inline-flex items-center gap-1 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
        >
          Decide later; recording and transcripts still work <ArrowRight size={11} />
        </button>
        <StepDots step={5} />
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

  if (step === 6) {
    const providerLabel = PROVIDERS[settings.provider]?.label ?? 'AI provider'
    // Windows has no OS-level permission API, so status is always 'unknown' there — that's a genuine
    // "we can't tell", not a granted status, so it must not be faked into `ok`. Surface it as a
    // not-yet-confirmed row instead, with a working link to the Windows privacy pane as the recovery path.
    const micWinUnknown = isWindows && perms?.microphone === 'unknown'
    const screenWinUnknown = isWindows && perms?.screenRecording === 'unknown'
    const micOk = perms?.microphone === 'granted'
    const screenOk = perms?.screenRecording === 'granted'
    // The headline only claims completion once every row below actually agrees; otherwise it stays a
    // neutral invitation to check, so it never contradicts a still-unmet item in the list underneath.
    const allReady = settings.providerReady && micOk && screenOk
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <MetisMark size={110} />
          <div
            ref={headingRef}
            tabIndex={-1}
            className="font-ui text-[20px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
          >
            {allReady ? 'You’re set.' : 'Let’s check you’re ready.'}
          </div>
        </div>

        <div className="flex w-full max-w-[460px] flex-col gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-4">
          <div className="mb-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Get ready
          </div>
          <CheckRow
            ok={settings.providerReady}
            label={PROVIDERS[settings.provider]?.kind === 'cli' ? `${providerLabel} connected` : `${providerLabel} API key`}
            hint="add it in Settings → AI"
            onFix={onOpenAiSettings}
            fixLabel="Open Settings → AI"
          />
          <CheckRow
            ok={micOk}
            denied={perms?.microphone === 'denied'}
            label="Microphone"
            hint={
              micWinUnknown
                ? "Windows won't report this until you use it. Check now, or let Listen ask."
                : 'grant access when you first press Listen'
            }
            onFix={() => void window.toto.openPermissionSettings('microphone')}
            fixLabel={micWinUnknown ? 'Check Windows Settings' : undefined}
          />
          <CheckRow
            ok={screenOk}
            denied={perms?.screenRecording === 'denied'}
            label="Screen recording"
            hint={
              screenWinUnknown
                ? "Windows won't report this until you use it. Check now, or let Listen ask."
                : 'needed for the other side of calls + screen capture'
            }
            onFix={() => void window.toto.openPermissionSettings('screenRecording')}
            fixLabel={screenWinUnknown ? 'Check Windows Settings' : undefined}
          />
        </div>

        <button
          type="button"
          onClick={() => void finish()}
          className="no-drag focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          Get started <ArrowRight size={14} />
        </button>
        {finishErr && (
          <div role="alert" className="text-[12px] text-[color:var(--color-danger)]">
            {finishErr}
          </div>
        )}
        <button
          type="button"
          onClick={() => setStep(5)}
          className="no-drag focus-ring text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
        >
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="fade-up flex min-h-[300px] w-full flex-col items-center justify-center gap-6 px-4 py-8 text-center">
      <MetisMark size={148} />

      <div className="flex flex-col gap-2">
        <div
          ref={headingRef}
          tabIndex={-1}
          className="font-ui text-[24px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
        >
          Métis. Your on-device AI copilot.
        </div>
        <p className="mx-auto max-w-[480px] text-[13.5px] leading-relaxed text-[color:var(--color-ink-2)]">
          Transcription runs locally, never leaving your device. Answers are grounded in
          your meeting context and cited so you can verify them. Everyone on the call knows it&apos;s there.
        </p>
        <p className="mx-auto max-w-[480px] text-[12px] italic leading-relaxed text-[color:var(--color-ink-3)]">
          Named for the Greek goddess of cunning wisdom and prudence, the intelligence that doesn&apos;t
          just know but sees what&apos;s coming, adapts, and picks the right moment. That&apos;s what
          Métis does for you, in every conversation.
        </p>
      </div>

      <div className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent-soft)] px-3 py-2 text-[12px] text-[color:var(--color-accent)]">
        <ShieldCheck size={12} />
        Audio is processed on your device and never uploaded.
      </div>

      <label className="no-drag flex w-full max-w-[460px] cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] p-3 text-left hover:bg-white/[0.06]">
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

      {err && (
        <div role="alert" className="text-[12px] text-[color:var(--color-danger)]">
          {err}
        </div>
      )}

      <div className="flex w-full max-w-[460px] flex-col gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => advance(true)}
          className={[
            'no-drag focus-ring flex items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:hover:brightness-100',
            busy ? 'cursor-not-allowed opacity-50' : ''
          ].join(' ')}
        >
          <MsLogo size={16} /> Sign in with Microsoft
        </button>
        <button
          type="button"
          disabled={busy}
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
        Mantu · Métis
      </div>
    </div>
  )
}
