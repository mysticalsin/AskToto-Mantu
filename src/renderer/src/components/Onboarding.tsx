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
  Building2,
  ChevronDown,
  Loader2
} from 'lucide-react'
import { DEFAULT_SHORTCUTS } from '@shared/ipc'
import type {
  PublicSettings,
  Profile,
  PlatformPermissions,
  ProfileRecoveryResult,
  DustCliImport,
  SignInResult
} from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS, filterAllowedProviders } from '@shared/providers'
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

// Mirrors Settings.tsx's managedChipCls — same "Managed by your organization" treatment, kept local here
// since Onboarding doesn't otherwise import from Settings.
const managedChipCls =
  'inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-1.5 py-0 text-[10px] font-medium text-[color:var(--color-accent-text)]'

/** Why a step-5 provider tile can't be tapped right now, or `null` if it can. Kept as a discriminated
 *  reason (not a plain boolean) so ProviderOption can show copy that matches what's actually true —
 *  'org' is a genuine managed-config/data-residency lock, 'busy' is only ever a transient in-flight
 *  probe (currently just the CLI tile's ~45s cliDetect/cliTest). Conflating the two previously made
 *  every tile read as org-restricted for the whole time the CLI tile alone was busy. */
export type ProviderTileDisabledReason = 'org' | 'busy' | null

/** Pure so it's unit-testable without a render harness (Onboarding.tsx has none). `busy` only ever
 *  applies to the CLI tile — the API-key and Mantu Dust tiles never pass it, so they can't be disabled
 *  by another tile's in-flight probe. */
export function providerTileDisabledReason(opts: {
  providerLocked: boolean
  pathAllowed: boolean
  busy?: boolean
}): ProviderTileDisabledReason {
  if (opts.providerLocked || !opts.pathAllowed) return 'org'
  if (opts.busy) return 'busy'
  return null
}

/** The API-key providers step 5's picker can route to, in preference order. One source for the tile
 *  grid, the "An API key" tile's enabled state, and the "Something else" escape hatch, so all three
 *  answer to the same org allowlist. */
const API_KEY_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'nvidia', 'minimax']

/** Where step 5's "Something else (DeepSeek, Qwen, Mistral, and more). Pick it in Settings" link lands.
 *  It used to be the literal 'anthropic', which walked straight past the data-residency allowlist the
 *  tile grid directly above it filters on — under an allowlist that omits Anthropic the link finished
 *  onboarding on a provider main rejects on every ask. `null` = the org approves no API-key provider at
 *  all, in which case the link must not render (the tile that opens this picker is already inert). */
export function apiPickerFallbackProvider(allowed: string[] | null | undefined): ProviderId | null {
  return filterAllowedProviders(API_KEY_PROVIDERS, allowed)[0] ?? null
}

/** Slide 1's reading of signIn(). `ok: true` with `configured: false` is main's "SSO isn't set up on
 *  this device" short-circuit (auth.ts): no browser opened, no session created. Consuming that as
 *  success advanced the walkthrough with nothing to show for the click, leaving the user believing they
 *  were on their work account. Mirrors SignInWall's branch on the same return value. */
export type SsoVerdict = 'signed-in' | 'not-configured' | 'failed'
export function ssoSignInVerdict(r: SignInResult): SsoVerdict {
  if (!r.ok) return 'failed'
  return r.configured === false ? 'not-configured' : 'signed-in'
}

/** Copy for step 6's provider readiness row. Dust needs its own branch: it's a one-click OAuth/CLI
 *  flow with no key to paste, so the generic API-key wording sends the user hunting for a key this
 *  path never asks for. */
export function providerReadyCopy(
  provider: ProviderId,
  /** MQA-263: true when this install already holds a working key it never asked the user for — the
   *  installer-embedded Cloudflare key. Without it the generic branch below tells someone to "add your
   *  key" for a key that shipped with the app and that they were never given a copy of. */
  opts?: { alreadyConnected?: boolean }
): { label: string; hint: string } {
  const p = PROVIDERS[provider]
  const label = p?.label ?? 'AI provider'
  if (opts?.alreadyConnected) return { label: `${label} connected`, hint: 'already set up, nothing to paste' }
  if (p?.kind === 'cli') return { label: `${label} connected`, hint: 'connect it to get live answers' }
  if (p?.kind === 'dust') return { label: `${label} connected`, hint: 'finish the one-click sign-in to get live answers' }
  return { label: `${label} API key`, hint: 'add your key to get live answers' }
}

/** Step 5's Mantu Dust path. Pure + injected (like providerTileDisabledReason) so the ORDER is testable
 *  without a render harness: dustImportCli writes the key and workspace id in the MAIN process only and
 *  there is no settings push channel — the renderer refetches settings on window 'focus', which never
 *  fires on the import path since nothing steals focus (`dust status` runs hidden, the session prompt
 *  auto-allows). Selecting Dust before the import and never re-reading afterwards left step 6 holding a
 *  pre-import snapshot, i.e. an amber "add your key" row for a workspace that was already connected. */
export async function connectDust(deps: {
  /** patch({ provider: 'dust' }) + advance. Stays first so the user isn't parked on step 5 for the import. */
  select: () => void
  importCli: () => Promise<DustCliImport>
  /** Fire-and-forget native OAuth device-flow start — it opens the browser, so the focus refetch covers it.
   *  The user finishes (code + workspace pick) in Settings, where the full flow lives. */
  setupCli: () => void
  /** Re-reads settings from main; a patch answers with the fresh snapshot. */
  refreshSettings: () => Promise<void>
  /** False once onboarding unmounted or the user left the readiness step — a late refresh must not
   *  overwrite whatever provider they picked in the meantime. */
  stillLive: () => boolean
}): Promise<void> {
  deps.select()
  const imported = await deps.importCli()
  if (!imported.ok) deps.setupCli()
  if (!deps.stillLive()) return
  await deps.refreshSettings()
}

/** One selectable "how to power Métis" path on the provider-choice slide. A plain-language card the
 *  user taps to route themselves — no jargon, no key required to read it. */
function ProviderOption({
  icon: Icon,
  title,
  badge,
  desc,
  onClick,
  disabledReason
}: {
  icon: typeof Mic
  title: string
  badge?: string
  desc: string
  onClick: () => void
  /** See providerTileDisabledReason() — `null`/undefined means tappable. */
  disabledReason?: ProviderTileDisabledReason
}): JSX.Element {
  const disabled = !!disabledReason
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'no-drag focus-ring group flex items-start gap-3 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3.5 text-left transition-colors hover:border-[var(--color-accent)] hover:bg-white/[0.05]',
        disabled ? 'cursor-not-allowed opacity-50 hover:border-[var(--color-hair-soft)] hover:bg-white/[0.02]' : ''
      ].join(' ')}
    >
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <Icon size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-[color:var(--color-ink)]">{title}</span>
          {disabledReason === 'org' ? (
            <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
              Restricted by your organization
            </span>
          ) : disabledReason === 'busy' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-ink-2)]">
              <Loader2 size={10} className="animate-spin" /> Checking…
            </span>
          ) : (
            badge && (
              <span className="rounded-full bg-[var(--color-success)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
                {badge}
              </span>
            )
          )}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-[color:var(--color-ink-2)]">{desc}</div>
      </div>
      <ArrowRight size={15} className="mt-1 shrink-0 text-[color:var(--color-ink-3)] group-hover:text-[color:var(--color-accent-text)]" />
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
          ok ? 'bg-[var(--color-success)] text-white' : 'bg-[var(--color-warn,#fac775)] text-[#3d2c00]'
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
            {/* Callers pass fixLabel for the Windows "status unknown" case, but a Windows user who
                explicitly DENIED the permission has a real 'denied' status, so fixLabel is undefined and
                this fallback shows — it must not name a macOS-only app. */}
            {fixLabel ?? (isWindows ? 'Open Windows Settings' : 'Open System Settings')}
          </button>
        )}
      </div>
    </div>
  )
}

/** 4-dot progress indicator for the walkthrough + provider-choice slides (2-4 are the toolbar tour, 5 is
 *  the provider picker; 1 and 6 are the consent gate and readiness gate, which don't need it since they're
 *  the bookends, not part of the countable sequence). Callers pass the RAW slide number (2-5) — normalized
 *  here to a 1-4 dot index so the first shown slide (step 2) lights dot 1 and announces "Step 1 of 4"
 *  instead of dot 2 / "Step 2 of 5". */
function StepDots({ step }: { step: number }): JSX.Element {
  const dot = step - 1 // raw slide 2-5 -> dot 1-4
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={`Step ${dot} of 4`}>
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          aria-current={n === dot ? 'step' : undefined}
          className={`h-1.5 w-1.5 rounded-full ${n === dot ? 'bg-[var(--color-accent)]' : 'bg-white/15'}`}
        >
          {/* Text alternative so the active step isn't conveyed by color alone (WCAG 1.4.1). */}
          {n === dot && <span className="sr-only">{`Step ${n} of 4`}</span>}
        </span>
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
  recoverEncryptedProfile,
  onDone,
  onOpenAiSettings,
  signedIn,
  signedInEmail,
  initialStep,
  initialConsent
}: {
  settings: PublicSettings
  saveKey?: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile?: () => Promise<ProfileRecoveryResult>
  // Real impl (state.ts) returns Promise<void> and awaits disk persistence; typed void to match the
  // Settings prop contract. `await patch(...)` still waits for the write before finish() calls onDone.
  patch: (p: Partial<PublicSettings>) => void
  onDone: () => void
  /** Optional: opens Settings -> AI in place, wired onto the provider/API-key readiness row. Parent
   *  wiring is added separately; the row simply has no click-through fix when this is left undefined. */
  onOpenAiSettings?: () => void
  /** Already signed in via Azure AD (App's useAuth) — e.g. Reset-onboarding re-drives this screen for a
   *  user who never signed out. When true, slide 1 must not offer to launch a fresh interactive OAuth: a
   *  reset promises "your settings won't change", and re-authenticating could silently switch identity. */
  signedIn?: boolean
  /** The signed-in account's email, shown in place of the generic "restricted to your org" caption. */
  signedInEmail?: string
  /** Start at a later step — OnboardingV2 runs the narrative experience first, then enters here at the
   *  provider step (5) so key setup + the final consent/permissions checklist stay this component's job. */
  initialStep?: 1 | 2 | 3 | 4 | 5 | 6
  /** Consent already affirmed upstream (OnboardingV2's checkbox). Seeds recordingConsent at mount so a
   *  not-yet-propagated patch can't make finish() re-persist `false`. Undefined = read from settings. */
  initialConsent?: boolean
  /** Ignored. The exclusive tour is mandatory; the skip-the-tour hatch is gone. */
  skipWalkthrough?: boolean
}): JSX.Element {
  // initialConsent overrides the persisted value at mount: OnboardingV2 enters this component at the
  // provider step AFTER its own required consent checkbox, but the patch({recordingConsent:true}) it
  // issues may not have propagated into `settings` yet — reading settings.recordingConsent here would
  // re-derive `false` and finish() would clobber the user's just-given consent (the CRITICAL audit bug).
  const [recordingConsent, setRecordingConsent] = useState(initialConsent ?? settings.recordingConsent)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [finishErr, setFinishErr] = useState('')
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(initialStep ?? 1)
  const [perms, setPerms] = useState<PlatformPermissions | null>(null)
  // Step 5's "An API key" card expands in place to name the actual providers instead of assuming
  // Anthropic — closes again if the user backs out of step 5 entirely.
  const [showApiPicker, setShowApiPicker] = useState(false)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  // Windows has no OS consent dialog for desktop apps — the mic toggle only becomes "determined" (from
  // this app's perspective) after it actually attempts a capture once. Fired at most once per mount.
  const micProbeFiredRef = useRef(false)
  // Step 5's chooseCli (below) awaits cliDetect + cliTest for up to ~45s with no earlier exit. `stepRef`
  // mirrors the live `step` (not the value closed over when chooseCli was called) and `mountedRef` tracks
  // whether Onboarding is still mounted, so a late resolution can never silently patch({ provider }) after
  // the user already left step 5 (Back, Decide later, Get started) or unmounted onboarding entirely.
  const [cliBusy, setCliBusy] = useState(false)
  const stepRef = useRef(step)
  useEffect(() => {
    stepRef.current = step
  }, [step])
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])
  // Set when the user bypasses an in-flight "Sign in with Microsoft" wait via "Continue without
  // signing in" — lets the abandoned signIn() promise's eventual resolution no-op instead of
  // yanking the user back to this step or surfacing a stale error once they've moved on.
  const abandonedSsoRef = useRef(false)

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
    if (!viaSso && busy) {
      // Bypassing a still-in-flight SSO wait (the loopback OAuth can block up to 5 minutes) —
      // mark it abandoned so its late resolution doesn't affect us once we've moved on.
      abandonedSsoRef.current = true
    }
    setBusy(true)
    try {
      // Already signed in (e.g. Reset-onboarding re-drives this screen for a user who never signed out) —
      // never re-launch an interactive OAuth: it could silently switch the signed-in identity, contradicting
      // "your settings won't change." The signed-in state is already correct; just continue the walkthrough.
      if (viaSso && !signedIn && window.toto.signIn) {
        abandonedSsoRef.current = false
        const r = await window.toto.signIn()
        if (abandonedSsoRef.current) return
        const verdict = ssoSignInVerdict(r)
        if (verdict !== 'signed-in') {
          // 'not-configured' comes back as ok:true, so advancing on it presented a no-op — no browser,
          // no session — as a successful work-account sign-in. Stay on this slide and say so; the
          // "Continue without signing in" button right below is then the honest way forward.
          setErr(
            verdict === 'not-configured'
              ? "Microsoft sign-in isn't set up on this device. Continue without signing in below."
              : r.error || 'Sign-in failed. Use a Mantu Microsoft account.'
          )
          setBusy(false)
          return
        }
      }
      setStep(2)
    } catch (e) {
      if (!abandonedSsoRef.current) setErr(e instanceof Error ? e.message : 'Could not continue.')
    } finally {
      setBusy(false)
    }
  }

  const finish = async (): Promise<void> => {
    setFinishErr('')
    setRecoveryAvailable(false)
    try {
      await patch({ onboardingDone: true, onboardingDoneAt: Date.now(), recordingConsent })
      onDone()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setFinishErr(`Couldn't save your setup. ${message}`)
      setRecoveryAvailable(!!recoverEncryptedProfile && /keychain|encrypted profile|secret.?key/i.test(message))
    }
  }

  const recoverProfileAndRetry = async (): Promise<void> => {
    if (!recoverEncryptedProfile) return
    setRecoveryBusy(true)
    setFinishErr('Creating a fresh local profile while preserving your encrypted data…')
    try {
      const result = await recoverEncryptedProfile()
      if (!result.ok) {
        setFinishErr(result.canceled ? 'Recovery canceled. Your encrypted profile was not changed.' : result.error || 'Could not create a new local profile.')
        return
      }
      setRecoveryAvailable(false)
      await patch({ onboardingDone: true, onboardingDoneAt: Date.now(), recordingConsent })
      onDone()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setFinishErr(`Couldn't save your setup. ${message}`)
      setRecoveryAvailable(/keychain|encrypted profile|secret.?key/i.test(message))
    } finally {
      setRecoveryBusy(false)
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
          <ActionRow icon={Camera} label="Capture screen" keys={accelLabel(settings.shortcuts?.['capture'] ?? DEFAULT_SHORTCUTS.capture)} hint="Get instant help with whatever you’re looking at." />
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
    // A locked `provider` (Settings' managedKeys) is not user-choosable — main silently drops the pick, so
    // the tiles must not pretend it's an option here either.
    const providerLocked = settings.managedKeys.includes('provider')
    // MQA-263: this build may already be connected. The installer can ship a Cloudflare key that main
    // seeds into the keystore on first launch, so `providerReady` is true before the user has done
    // anything — yet this step still opened with "pick one way to connect the AI" and offered a picker
    // whose escape hatch named DeepSeek. That asks someone to solve a problem they do not have, and
    // points them at a provider they would have to go and sign up for, while a working one is already
    // configured. The tiles stay available underneath, because switching is still legitimate.
    const alreadyConnected = settings.providerReady && !providerLocked
    // Org data-residency allowlist (null = unrestricted): these path tiles route straight to a provider,
    // so each needs its own check — the CLI tile covers claude-cli/codex-cli (whichever chooseCli detects).
    const pathAllow = settings.allowedProviders
    const dustPathAllowed = !pathAllow || pathAllow.includes('dust')
    const cliPathAllowed = !pathAllow || pathAllow.includes('claude-cli') || pathAllow.includes('codex-cli')
    // The "An API key" tile is inert when the org approves no API-key provider at all — otherwise it
    // would open an empty picker (its own tiles are allow-filtered below).
    const apiChoices = filterAllowedProviders(API_KEY_PROVIDERS, pathAllow)
    const apiPathAllowed = apiChoices.length > 0
    const apiFallback = apiPickerFallbackProvider(pathAllow)
    const choose = (provider: ProviderId): void => {
      patch({ provider })
      setStep(6)
    }
    // "Claude Code or Codex" is one tile for two different CLIs, so detect which one is actually on
    // the machine instead of always assuming Claude Code (otherwise a Codex-only install lands on the
    // wrong provider and the next screen shows it as not connected).
    const chooseCli = async (): Promise<void> => {
      setCliBusy(true)
      try {
        const claude = await window.toto.cliDetect('claude-cli')
        if (claude.ok) {
          // Verify the connection now (mirrors Settings.tsx's connect flow) so providerReady reflects
          // reality immediately instead of the first Ask silently bouncing off a CLI that's installed but
          // was never actually confirmed connected. A cliTest failure (installed but not signed in) still
          // lets onboarding proceed — the readiness checklist on the next slide surfaces the hint.
          await window.toto.cliTest('claude-cli')
          // Bail if the user left step 5 (Back/Decide later/Get started) or unmounted while this awaited —
          // otherwise this would silently overwrite whatever provider they set in the meantime.
          if (!mountedRef.current || stepRef.current !== 5) return
          choose('claude-cli')
          return
        }
        const codex = await window.toto.cliDetect('codex-cli')
        if (codex.ok) await window.toto.cliTest('codex-cli')
        if (!mountedRef.current || stepRef.current !== 5) return
        choose(codex.ok ? 'codex-cli' : 'claude-cli')
      } finally {
        if (mountedRef.current) setCliBusy(false)
      }
    }
    // "Mantu Dust" isn't just a preference — kick off sign-in right here so onboarding ends CONNECTED, not
    // just with Dust selected. Import an existing Dust CLI session if there is one; otherwise start the
    // native OAuth device flow (opens the browser) fire-and-forget — the user finishes it (code + pick a
    // workspace) in Settings, where the full flow lives. No dead-end: the user still lands on step 6 and
    // can finish there either way.
    const chooseDust = async (): Promise<void> => {
      await connectDust({
        select: () => choose('dust'),
        importCli: () => window.toto.dustImportCli(),
        setupCli: () => void window.toto.dustLoginBegin(),
        // Re-patching the provider we just set is the renderer's only way to pull main's post-import
        // snapshot (setSettings answers with it) — settings are otherwise refetched on window 'focus'
        // alone, which this path never triggers.
        refreshSettings: async () => {
          await patch({ provider: 'dust' })
        },
        stillLive: () => mountedRef.current && stepRef.current === 6
      })
    }
    return (
      <div className="fade-up flex min-h-[300px] w-full flex-col items-center gap-5 px-4 py-7 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <div
            ref={headingRef}
            tabIndex={-1}
            className="font-ui text-[18px] font-semibold tracking-tight text-[color:var(--color-ink)] outline-none"
          >
            {alreadyConnected ? 'Métis is ready to answer' : 'How should Métis answer you?'}
          </div>
          <p className="max-w-[460px] text-[12px] leading-snug text-[color:var(--color-ink-2)]">
            {alreadyConnected ? (
              <>
                This build ships connected to {PROVIDERS[settings.provider]?.label ?? 'an AI provider'}, so
                there is no key to paste and nothing to sign up for. Transcription still runs free on your
                device. Prefer your own provider? Pick one below, or change it any time in Settings.
              </>
            ) : (
              <>
                Transcription is always free and runs on your device. To get live answers, pick one way to
                connect the AI. You can change this any time in Settings.
              </>
            )}
          </p>
        </div>

        <div className="flex w-full max-w-[460px] flex-col gap-2.5">
          <ProviderOption
            icon={Terminal}
            title="Claude Code or Codex"
            badge="No key needed"
            desc="Already use Claude Code or Codex in your terminal? Connect it. Nothing extra to pay, nothing to paste."
            onClick={() => void chooseCli()}
            disabledReason={providerTileDisabledReason({ providerLocked, pathAllowed: cliPathAllowed, busy: cliBusy })}
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
                {/* Honor the org data-residency allowlist (null = unrestricted) so onboarding never
                    offers a provider every ask would then reject — same source main enforces. */}
                {apiChoices.map((id) => (
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
              {/* Same allowlist as the grid above (see apiPickerFallbackProvider): a hard-coded
                  'anthropic' here bypassed the very check this block's comment promises. */}
              {apiFallback && (
                <button
                  type="button"
                  onClick={() => choose(apiFallback)}
                  className="no-drag focus-ring text-left text-[11.5px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
                >
                  Something else (DeepSeek, Qwen, Mistral, and more). Pick it in Settings
                </button>
              )}
            </div>
          ) : (
            <ProviderOption
              icon={KeyRound}
              title="An API key"
              desc="Claude, GPT, Grok, Kimi, and more. Paste your key and you're set. You pay your provider directly."
              onClick={() => setShowApiPicker(true)}
              disabledReason={providerTileDisabledReason({ providerLocked, pathAllowed: apiPathAllowed })}
            />
          )}
          <ProviderOption
            icon={Building2}
            title="Mantu Dust"
            badge="One-click setup"
            desc="Use Mantu's shared Dust workspace. Installs and signs you in automatically. No key to paste."
            onClick={() => void chooseDust()}
            disabledReason={providerTileDisabledReason({ providerLocked, pathAllowed: dustPathAllowed })}
          />
        </div>
        {providerLocked && <span className={managedChipCls}>Managed by your organization</span>}

        <button
          type="button"
          onClick={() => setStep(6)}
          className="no-drag focus-ring inline-flex items-center gap-1 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
        >
          {/* MQA-263: "Decide later" tells someone nothing works yet. When the build already ships a
              working provider, the honest label is that they are done. */}
          {alreadyConnected ? (
            <>Keep {PROVIDERS[settings.provider]?.label ?? 'the built-in provider'} and continue</>
          ) : (
            <>Decide later; recording and transcripts still work</>
          )}{' '}
          <ArrowRight size={11} />
        </button>
        {(initialStep ?? 1) < 5 && <StepDots step={5} />}
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
    // MQA-263: a provider that is ALREADY ready needs no instruction. Passing readiness through stops
    // the row reading "Cloudflare · AI Gateway API key — add your key to get live answers" for a key the
    // installer supplied and the user never had.
    const readyCopy = providerReadyCopy(settings.provider, { alreadyConnected: settings.providerReady })
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
            label={readyCopy.label}
            hint={readyCopy.hint}
            // Settings can only render once the onboarding gate clears (App returns this panel while
            // !onboardingDone), so complete onboarding first — otherwise this link is a silent no-op,
            // a dead end on the one remediation the readiness checklist offers. finish() persists
            // consent + onboardingDone; on its failure the error banner shows and we stay here.
            onFix={onOpenAiSettings ? async (): Promise<void> => { await finish(); onOpenAiSettings() } : undefined}
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
        {recoveryAvailable && (
          <button
            type="button"
            onClick={() => void recoverProfileAndRetry()}
            disabled={recoveryBusy}
            className="no-drag focus-ring inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-4 py-2 text-[12px] font-medium text-[color:var(--color-accent)] hover:brightness-110 disabled:opacity-50"
          >
            {recoveryBusy ? <KeyRound size={13} className="animate-pulse" /> : <KeyRound size={13} />}
            {recoveryBusy ? 'Creating new local profile…' : 'Create new local profile & retry'}
          </button>
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
    <div className="fade-up flex min-h-[300px] w-full flex-col items-center justify-center gap-6 rounded-3xl border border-white/10 bg-[linear-gradient(165deg,#3A0B6B_0%,#22084A_45%,#160030_100%)] px-6 py-10 text-center shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
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

      <div className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent-soft)] px-3 py-2 text-[12px] text-[color:var(--color-accent-text)]">
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
            'no-drag focus-ring flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(180deg,#9A2BF0_0%,#7F00DA_100%)] px-4 py-2.5 text-[14px] font-semibold text-white shadow-[0_8px_24px_rgba(127,0,218,0.45)] hover:brightness-110 disabled:hover:brightness-100',
            busy ? 'cursor-not-allowed opacity-50' : ''
          ].join(' ')}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <MsLogo size={16} />}
          {busy ? 'Waiting for your browser…' : 'Sign in with Microsoft'}
        </button>
        {busy && (
          <p className="text-[11px] leading-snug text-[color:var(--color-ink-3)]" role="status">
            A Microsoft window opened. Finish there, or continue without signing in below.
          </p>
        )}
        {/* The skip-sign-in path only makes sense as a SEPARATE option next to the SSO button above —
            once already signed in there is only one path, so the button would be a redundant, confusing
            no-op (advance(false) either way). Exactly ONE skip button renders: 6b75daf added this gated
            version but left the old unconditional copy above it, so first-run users saw it twice
            (reported + fixed 2026-08-04; pinned by onboarding-dedup.contract.test.ts). */}
        {!signedIn && (
          <button
            type="button"
            disabled={busy || !recordingConsent}
            onClick={() => advance(false)}
            className="no-drag focus-ring inline-flex items-center justify-center gap-1 rounded-xl px-4 py-2 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-[color:var(--color-ink-3)]"
          >
            Continue without signing in <ArrowRight size={12} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-3)]">
        <ShieldCheck size={12} className="text-[color:var(--color-accent-text)]" />
        {signedIn
          ? `Signed in${signedInEmail ? ` as ${signedInEmail}` : ''} · permissions are requested the first time you Listen.`
          : 'Restricted to your Mantu Microsoft account · permissions are requested the first time you Listen.'}
      </div>

      <div className="text-[10px] text-[color:var(--color-ink-3)]">
        Mantu · Métis
      </div>
    </div>
  )
}
