/**
 * Métis onboarding as an EXPERIENCE — five-act narrative per docs/ONBOARDING-EXPERIENCE.md
 * (anatomy extracted from the Vibe Island reference Tony supplied: hero → staged problem story →
 * reveal → live environment-scan magic moment → personalization/landing).
 *
 * Deliberate constraints:
 * - No animation libraries — CSS transitions + staged `animation-delay` only, like the rest of the app.
 *   The exceptions are Act 1's wordmark scramble (HeroWelcome below) and Act 2's synthetic cursor
 *   (OnboardingDemoScene), both of which need a per-frame projection CSS cannot express — small rAF
 *   loops over pure helpers in lib/scramble.ts and lib/synthetic-cursor.ts, not a dependency.
 * - Scene 4's checks are REAL (getPermissions / requestPermissionsUpfront / asrBundled) — a row only
 *   ever shows "ready" when it is actually true. Never fake the magic moment.
 * - Act 2 (reveal) is the one deliberate exception to "never fake" — it drives Métis's REAL Bar/
 *   Copilot/Answer/QuickActions components with a scripted fake meeting (MQA-277), guarded so fake data
 *   can never persist and the demo can never see real data (MQA-278, @shared/demo-guard).
 * - Self-contained: mounts in place of the legacy tour via App's onboarding gate; everything the host
 *   needs comes back through onDone.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, FolderLock, Mic, MonitorUp, Sparkles } from 'lucide-react'
import type { ConversationMode, PermissionStatus, ProfileRecoveryResult, PublicSettings } from '@shared/ipc'
import type { ProviderId } from '@shared/providers'
import { PERMISSIONS_POLL_MS } from '../state'
import { MetisMark } from './MetisMark'
import { Onboarding } from './Onboarding'
import { OnboardingDemoScene } from './OnboardingDemoScene'
import { isWindows } from '../lib/keys'
import { useScrambleReveal } from '../lib/scramble'

export interface OnboardingExperienceProps {
  onDone: (result: { mode: ConversationMode; recordingConsent: boolean }) => void
  /** Optional escape hatch to the old flow while this one beds in. */
  onSkip?: () => void
}

/** Wave 5 — problem story (docs/ONBOARDING-EXPERIENCE.md Scene 2): staged lines, one at a time. */
const PROBLEM_STORY: string[] = [
  "You're in the meeting.",
  'The question lands on you.',
  'You know that you know it.',
  '…and the moment passes.'
]

type Scene = 'hero' | 'problem' | 'reveal' | 'setup' | 'personalize'

// Hero is the welcome beat, not a "step" — the dots only track the guided acts after it.
const GUIDED_SCENES: Scene[] = ['problem', 'reveal', 'setup', 'personalize']

// Lives in its own reserved-height row above the scene content (see the render below) rather than an
// absolute overlay — an overlay collided with scene headings that sit close to the top on taller scenes
// (e.g. "Your setup"'s 5 rows push the h2 up into where an absolutely-positioned dot row would sit).
function ActProgress({ scene }: { scene: Scene }): JSX.Element | null {
  const idx = GUIDED_SCENES.indexOf(scene)
  if (idx < 0) return null
  return (
    <div className="fade-up flex items-center gap-1.5" aria-hidden="true">
      {GUIDED_SCENES.map((s, i) => (
        <span
          key={s}
          className={
            'h-1.5 rounded-full transition-all duration-300 ' +
            (i === idx ? 'w-5 bg-[var(--color-accent)]' : i < idx ? 'w-1.5 bg-[var(--color-accent)]/50' : 'w-1.5 bg-white/15')
          }
        />
      ))}
    </div>
  )
}

const WORDMARK = 'Métis'

/**
 * Act 1 — Welcome (MQA-276). The Métis mark lands as a top-center "island" capsule and the wordmark
 * resolves out of scrambled glyphs, in the spirit of the notch-capsule materialization researched in
 * the Vibe Island teardown (motion FEEL only — own copy, own mark, own timing; see docs/qa/BUG-LEDGER.md
 * MQA-276 and the teardown PDF for the reference). Every beat is CSS keyframes (`.island-capsule` +
 * friends in styles.css, staged with `animation-delay` like the rest of this file) except the wordmark,
 * which is the one place a JS-driven effect earns its keep — `useScrambleReveal` (src/renderer/src/lib/
 * scramble.ts) is a small rAF loop over a pure, independently-tested projection function. Both honor
 * `prefers-reduced-motion`: the CSS keyframes fall out of the existing global `animation-duration: 0`
 * rule (plus explicit end-state overrides below for the ones with a custom-property angle), and the
 * scramble hook checks the media query itself and skips straight to the resolved word.
 */
function HeroWelcome({ onBegin, onSkip }: { onBegin: () => void; onSkip?: () => void }): JSX.Element {
  const wordmark = useScrambleReveal(WORDMARK, 900)
  return (
    <div className="scene-enter flex flex-col items-center gap-5">
      <div className="island-capsule" aria-hidden="true">
        <span className="island-capsule-mark">
          <MetisMark size={40} />
        </span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <h1
          className="hero-wordmark m-0 select-none"
          aria-label={WORDMARK}
          style={{ fontFamily: 'var(--font-ui)' }}
        >
          <span aria-hidden="true">{wordmark}</span>
        </h1>
        <p
          className="hero-tagline fade-up m-0 text-[14px] text-[color:var(--color-ink-2)]"
          style={{ animationDelay: '900ms', animationFillMode: 'backwards' }}
        >
          Your on-device meeting copilot.
        </p>
      </div>
      <button
        type="button"
        onClick={onBegin}
        className="fade-up no-drag focus-ring h-10 rounded-full bg-[var(--color-accent)] px-6 text-[13px] font-semibold text-white shadow-[0_2px_16px_var(--color-accent-glow)] hover:brightness-110"
        style={{ animationDelay: '1000ms', animationFillMode: 'backwards' }}
      >
        Get Started
      </button>
      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="fade-up no-drag text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
          style={{ animationDelay: '1150ms', animationFillMode: 'backwards' }}
        >
          Skip the tour
        </button>
      )}
      <p
        className="hero-byline fade-up m-0 text-[10px] tracking-wide text-[color:var(--color-ink-3)]"
        style={{ animationDelay: '1300ms', animationFillMode: 'backwards' }}
      >
        Mantu · Tony Walteur
      </p>
    </div>
  )
}

// 'restart' = permission is actually granted, but this same-session ScreenCaptureKit handle never saw it
// (macOS only applies a fresh Screen Recording grant to the NEXT launch) — needs a relaunch, not a prompt.
// 'blocked' = the OS holds an explicit Deny, which no prompt can undo — only the privacy pane can.
export type SetupRowState = 'checking' | 'ready' | 'action' | 'blocked' | 'restart' | 'skipped'

interface SetupRow {
  key: string
  label: string
  icon: typeof Sparkles
  state: SetupRowState
  detail?: string
}

/** The microphone row for an OS permission status. 'denied' MUST be its own state: getUserMedia never
 *  re-prompts after an explicit Deny and main's requestPermissionsUpfront only asks while the status is
 *  'not-determined', so in that state the "Allow Microphone" button produces no prompt, no error and no
 *  change — the OS privacy pane is the only way back, exactly as the screen row already offers. */
export function micRowStatus(status: PermissionStatus | undefined): { state: SetupRowState; detail: string } {
  if (status === 'granted') return { state: 'ready', detail: 'granted' }
  if (status === 'denied') return { state: 'blocked', detail: 'permission denied' }
  return { state: 'action', detail: 'needs permission' }
}

export function OnboardingExperience({ onDone, onSkip }: OnboardingExperienceProps): JSX.Element {
  const [scene, setScene] = useState<Scene>('hero')
  const [rows, setRows] = useState<SetupRow[]>([])
  const [mode, setMode] = useState<ConversationMode>('general')
  // Recording-consent gate. Entering the legacy flow at its provider step skips legacy slide 1 — the
  // ONLY place the consent checkbox lived — which silently persisted recordingConsent:false for every
  // new-flow user (CMO-QA finding #1). The checkbox is therefore a REQUIRED gate here, before Start.
  const [consent, setConsent] = useState(false)
  const doneRef = useRef(false)
  // Tracks the last-seen screenRecording status across polls so a false→true flip mid-scene (the user
  // just toggled it on in System Settings) can be told apart from "was already granted on mount" — only
  // the former needs a restart, since this process's ScreenCaptureKit handle never saw the earlier one.
  const screenGrantedRef = useRef<boolean | null>(null)
  const [restarting, setRestarting] = useState(false)

  // --- Setup scene: run the REAL checks the moment the scene mounts.
  useEffect(() => {
    if (scene !== 'setup') return
    let live = true
    const base: SetupRow[] = [
      // No acceleration row (MQA-201): it asserted "ready / detected" unconditionally, justified by a
      // claim that the build was arm64-only. It is not — the mac target is universal (electron-builder
      // verifies x64 Mach-O slices) and Windows ships x64 only. Nor can the renderer honestly answer the
      // question at this point: on Windows the llama variant
      // (vulkan vs cpu) is only decided when a sidecar is first spawned, which has not happened yet at
      // onboarding. docs/ONBOARDING-EXPERIENCE.md's rule is to show only rows that are actually true.
      { key: 'asr', label: 'On-device transcription', icon: Sparkles, state: 'checking' },
      { key: 'brain', label: 'Private meeting brain', icon: FolderLock, state: 'checking' },
      { key: 'mic', label: 'Microphone', icon: Mic, state: 'checking' },
      { key: 'screen', label: 'Screen context', icon: MonitorUp, state: 'checking' }
    ]
    setRows(base)
    screenGrantedRef.current = null
    const set = (key: string, state: SetupRowState, detail?: string): void => {
      if (!live) return
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, state, detail } : r)))
    }
    // Stagger the resolutions so each row visibly "lands" — but every verdict is real.
    void (async () => {
      const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      await delay(500)
      const bundled = await window.toto.asrBundled().catch(() => false)
      set('asr', bundled ? 'ready' : 'action', bundled ? 'Parakeet + Whisper bundled' : 'models missing in this build')
      await delay(450)
      set('brain', 'ready', isWindows ? 'stays on this PC' : 'stays on this Mac')
      await delay(450)
      const perms = await window.toto.getPermissions().catch(() => null)
      const mic = micRowStatus(perms?.microphone)
      set('mic', mic.state, mic.detail)
      await delay(350)
      // Windows has no per-app Screen Recording permission — desktopCapturer captures without one, so the
      // status stays 'unknown' forever there. Treat isWindows as screen-available (matches Onboarding.tsx
      // and listen.ts) so the scene never demands a grant the OS can't give and can actually reach "ready".
      const screenGranted = isWindows || perms?.screenRecording === 'granted'
      screenGrantedRef.current = screenGranted
      set('screen', screenGranted ? 'ready' : 'action', isWindows ? 'available' : screenGranted ? 'granted' : 'needs permission')
      // Proactively trigger the real OS consent flow the moment setup lands, instead of waiting for a
      // button press: macOS pops the mic prompt and registers Métis in the Screen Recording TCC list
      // (the pane doesn't even list an app until it has probed once); Windows resolves mic consent via a
      // one-shot getUserMedia probe (there is no main-process ask API — requestPermissionsUpfront is a
      // darwin no-op, which is why the old mic button never did anything on Windows). Fire-and-forget:
      // the live poll below reflects the outcome, and macOS never re-prompts after an explicit Deny, so
      // repeats are safe.
      if (isWindows && perms?.microphone !== 'granted') {
        void navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => stream.getTracks().forEach((t) => t.stop()))
          .catch(() => {})
      }
      if (!isWindows && perms && (perms.microphone !== 'granted' || perms.screenRecording !== 'granted')) {
        void window.toto.requestPermissionsUpfront().catch(() => null)
      }
    })()
    return () => {
      live = false
    }
  }, [scene])

  // --- Live-poll while the scene stays mounted, so a grant flipped in System Settings (possibly in a
  // split view right next to this window) is reflected without the user coming back to click anything.
  useEffect(() => {
    if (scene !== 'setup') return
    let live = true
    const poll = async (): Promise<void> => {
      const perms = await window.toto.getPermissions().catch(() => null)
      if (!live || !perms) return
      setRows((rs) =>
        rs.map((r) => {
          if (r.key === 'mic') {
            const mic = micRowStatus(perms.microphone)
            return { ...r, state: mic.state, detail: mic.detail }
          }
          if (r.key === 'screen') {
            // On Windows screen capture needs no grant (see mount effect) — always available, never a
            // restart. The false→true "just granted, needs restart" dance is macOS ScreenCaptureKit only.
            const granted = isWindows || perms.screenRecording === 'granted'
            const justGranted = !isWindows && screenGrantedRef.current === false && granted
            screenGrantedRef.current = granted
            const needsRestart = justGranted || (!isWindows && r.state === 'restart')
            return {
              ...r,
              state: needsRestart ? 'restart' : granted ? 'ready' : 'action',
              detail: needsRestart ? 'granted' : isWindows ? 'available' : granted ? 'granted' : 'needs permission'
            }
          }
          return r
        })
      )
    }
    const interval = setInterval(() => void poll(), PERMISSIONS_POLL_MS)
    return () => {
      live = false
      clearInterval(interval)
    }
  }, [scene])

  const requestMic = async (): Promise<void> => {
    // Windows: main's requestPermissionsUpfront is a darwin no-op — the only thing that resolves mic
    // consent there is an actual getUserMedia call from the renderer (same probe the legacy onboarding
    // used). A rejection just means blocked; the status poll + fix link handle that.
    if (isWindows) {
      await navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => stream.getTracks().forEach((t) => t.stop()))
        .catch(() => {})
    }
    const perms = await window.toto.requestPermissionsUpfront().catch(() => null)
    const mic = micRowStatus(perms?.microphone)
    setRows((rs) => rs.map((r) => (r.key === 'mic' ? { ...r, state: mic.state, detail: mic.detail } : r)))
  }

  const restartApp = (): void => {
    setRestarting(true)
    void window.toto.relaunch().catch(() => setRestarting(false))
  }

  const finish = (): void => {
    if (doneRef.current || !consent) return
    doneRef.current = true
    onDone({ mode, recordingConsent: true })
  }

  const allReady = rows.length > 0 && rows.every((r) => r.state === 'ready' || r.state === 'skipped')
  // 'blocked' counts here for the same reason 'action' does — it was one of those states before it got
  // its own name, and Continue must not go primary while the mic is still denied.
  const needsPerms = rows.some(
    (r) => (r.key === 'mic' || r.key === 'screen') && (r.state === 'action' || r.state === 'blocked' || r.state === 'restart')
  )

  return (
    <div className="flex h-full w-full select-none flex-col items-center px-10 text-center">
      <div className="flex h-9 shrink-0 items-center justify-center pt-3">
        <ActProgress scene={scene} />
      </div>
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6">
      {scene === 'hero' && <HeroWelcome onBegin={() => setScene('problem')} onSkip={onSkip} />}

      {scene === 'problem' && (
        <div key="problem" className="scene-enter flex flex-col items-center gap-8">
          <div className="flex max-w-[420px] flex-col gap-3 text-left">
            {PROBLEM_STORY.map((line, i) => (
              <p
                key={line}
                className="fade-up m-0 text-[22px] font-medium leading-snug text-[color:var(--color-ink)]"
                style={{
                  animationDelay: `${200 + i * 1100}ms`,
                  animationFillMode: 'backwards',
                  opacity: 1
                }}
              >
                {line}
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setScene('reveal')}
            className="no-drag focus-ring h-10 rounded-full bg-[var(--color-accent)] px-6 text-[13px] font-semibold text-white hover:brightness-110"
            style={{ animationDelay: `${200 + PROBLEM_STORY.length * 1100}ms` }}
          >
            Continue
          </button>
        </div>
      )}

      {scene === 'reveal' && (
        <OnboardingDemoScene
          onContinue={() => setScene('setup')}
          // Skip-available-from-here (per the Act 2 brief): jumps straight to Personalize — unlike
          // HeroWelcome's onSkip (which restarts the entire legacy flow from its own slide 1), this
          // keeps everything already shown (Welcome, the problem story, the demo) and just gets the
          // user to Start faster, bypassing the real permission checklist.
          onSkipToEnd={() => setScene('personalize')}
        />
      )}

      {scene === 'setup' && (
        <div key="setup" className="scene-enter flex flex-col items-center gap-6">
          <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">Your setup</h2>
          <div className="flex w-full max-w-[440px] flex-col gap-2">
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="glass-strong fade-up flex items-start gap-3 rounded-[12px] px-3.5 py-2.5 text-left"
                style={{ animationDelay: `${i * 70}ms`, animationFillMode: 'backwards' }}
              >
                <r.icon size={16} className="mt-0.5 shrink-0 text-[color:var(--color-ink-2)]" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13px] text-[color:var(--color-ink)]">{r.label}</p>
                  {r.detail && <p className="m-0 text-[11px] text-[color:var(--color-ink-3)]">{r.detail}</p>}
                  {/* Why-before-prompt: shown before the button that triggers the OS dialog / deep link, not
                      after — so the user knows what they're being asked for before they're asked. */}
                  {r.key === 'mic' && r.state === 'action' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Lets Métis hear your side of the call.
                      </span>
                      <button
                        type="button"
                        onClick={() => void requestMic()}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Allow Microphone
                      </button>
                    </div>
                  )}
                  {r.key === 'mic' && r.state === 'blocked' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        {isWindows
                          ? "Windows is blocking the microphone — turn it back on in Privacy settings."
                          : "macOS won't ask again once you've said no — turn it back on in Privacy settings."}
                      </span>
                      <button
                        type="button"
                        onClick={() => void window.toto.openPermissionSettings('microphone')}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Open Microphone Settings
                      </button>
                    </div>
                  )}
                  {r.key === 'screen' && r.state === 'action' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Lets Métis answer questions about what's on your screen.
                      </span>
                      <button
                        type="button"
                        onClick={() => void window.toto.openPermissionSettings('screenRecording')}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
                      >
                        Open Screen Recording Settings
                      </button>
                    </div>
                  )}
                  {r.key === 'screen' && r.state === 'restart' && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] leading-snug text-[color:var(--color-accent-2)]">
                        Granted. Restart Métis to finish enabling it.
                      </span>
                      <button
                        type="button"
                        onClick={restartApp}
                        disabled={restarting}
                        className="no-drag focus-ring rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-semibold text-white hover:brightness-110 disabled:opacity-60"
                      >
                        {restarting ? 'Restarting…' : 'Restart Métis'}
                      </button>
                    </div>
                  )}
                </div>
                {r.state === 'checking' && (
                  <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-[var(--color-accent-2)]" />
                )}
                {r.state === 'ready' && <Check size={16} className="mt-0.5 shrink-0 text-[var(--color-accent-2)]" />}
                {r.state === 'action' && <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--color-ink-2)]">needed</span>}
                {r.state === 'blocked' && <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--color-ink-2)]">blocked</span>}
                {r.state === 'restart' && (
                  <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--color-accent-2)]">restart</span>
                )}
              </div>
            ))}
          </div>
          {allReady && (
            <p className="fade-up m-0 text-[14px] font-medium text-[color:var(--color-ink)]">
              Everything’s ready. Nothing to configure.
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setScene('personalize')}
              className={
                'no-drag focus-ring h-10 rounded-full px-5 text-[13px] font-semibold ' +
                (needsPerms
                  ? 'text-[color:var(--color-ink-2)] hover:bg-white/10'
                  : 'bg-[var(--color-accent)] text-white hover:brightness-110')
              }
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {scene === 'personalize' && (
        <div key="personalize" className="scene-enter flex flex-col items-center gap-6">
          <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">How will you use Métis?</h2>
          <div className="flex gap-3">
            {(
              [
                { id: 'general', label: 'General', desc: 'Every meeting, every topic' },
                { id: 'sales', label: 'Sales', desc: 'Deals, objections, next steps' },
                { id: 'recruiting', label: 'Recruiting', desc: 'You interview: STAR probes, challenges' }
              ] as Array<{ id: ConversationMode; label: string; desc: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={
                  'no-drag focus-ring w-[150px] rounded-[14px] border px-4 py-3 text-left transition-all duration-150 ' +
                  (mode === m.id
                    ? 'scale-[1.03] border-[var(--color-accent)] bg-[var(--color-accent-soft)] shadow-[0_2px_14px_var(--color-accent-glow)]'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]')
                }
              >
                <p className="m-0 text-[13px] font-semibold text-[color:var(--color-ink)]">{m.label}</p>
                <p className="m-0 mt-0.5 text-[11px] leading-snug text-[color:var(--color-ink-2)]">{m.desc}</p>
              </button>
            ))}
          </div>
          <div className="flex flex-col items-center gap-3">
            <label className="flex max-w-[420px] cursor-pointer items-start gap-2.5 rounded-[12px] border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-left">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="no-drag mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="text-[12px] leading-snug text-[color:var(--color-ink-2)]">
                I’ll tell everyone on the call before I record, and follow my company’s policy and the law.
              </span>
            </label>
            <p className="m-0 text-[15px] font-medium text-[color:var(--color-ink)]">Ready when you are.</p>
            <button
              type="button"
              onClick={finish}
              disabled={!consent}
              className={
                'no-drag focus-ring h-10 rounded-full px-7 text-[13px] font-semibold text-white ' +
                (consent
                  ? 'bg-[var(--color-accent)] shadow-[0_2px_16px_var(--color-accent-glow)] hover:brightness-110'
                  : 'cursor-not-allowed bg-white/10 opacity-60')
              }
            >
              Start
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/**
 * The full first-run flow: the five-act experience above, then the legacy component entered at its
 * PROVIDER step (5) so API-key setup + the final consent/permissions checklist keep their proven
 * implementation. Mode from the personalize scene is persisted before the handoff.
 */
export function OnboardingV2({
  settings,
  saveKey,
  recoverEncryptedProfile,
  patch,
  onOpenAiSettings,
  onDone,
  signedIn,
  signedInEmail
}: {
  settings: PublicSettings
  saveKey?: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile?: () => Promise<ProfileRecoveryResult>
  patch: (p: Partial<PublicSettings>) => void
  onOpenAiSettings?: () => void
  onDone: () => void
  signedIn?: boolean
  signedInEmail?: string
}): JSX.Element {
  // 'legacy-full' = the Skip path: the user opted out of the narrative, so they get the ENTIRE legacy
  // flow from slide 1 — its consent gate included. Skipping must never skip consent (CMO-QA #1).
  const [phase, setPhase] = useState<'experience' | 'provider' | 'legacy-full'>('experience')
  if (phase === 'experience') {
    return (
      <OnboardingExperience
        onDone={({ mode, recordingConsent }) => {
          patch({ mode, recordingConsent })
          setPhase('provider')
        }}
        onSkip={() => setPhase('legacy-full')}
      />
    )
  }
  return (
    <Onboarding
      settings={settings}
      saveKey={saveKey}
      recoverEncryptedProfile={recoverEncryptedProfile}
      patch={patch}
      onOpenAiSettings={onOpenAiSettings}
      onDone={onDone}
      signedIn={signedIn}
      signedInEmail={signedInEmail}
      initialStep={phase === 'legacy-full' ? 1 : 5}
      // Provider phase = the experience's required consent checkbox was already ticked. Seed it so a
      // still-in-flight patch can't let the legacy finish() re-persist false. legacy-full = the Skip
      // path, which hits the real consent slide 1, so leave it to read from settings.
      initialConsent={phase === 'provider' ? true : undefined}
      // legacy-full still needs its own consent slide (1), but must not then walk slides 2-4 — that
      // would make "Skip the tour" show MORE screens than just finishing the narrative experience does.
      skipWalkthrough={phase === 'legacy-full'}
    />
  )
}
