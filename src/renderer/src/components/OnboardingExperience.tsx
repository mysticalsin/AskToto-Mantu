/**
 * Métis onboarding as an EXPERIENCE — six-act narrative per docs/ONBOARDING-EXPERIENCE.md, now that
 * Act 6 (Ready, MQA-283) closes it out: hero → staged problem story → reveal → live environment-scan
 * magic moment → personalization/vibe → [license, optional] → Ready → finish (anatomy extracted from
 * the Vibe Island reference Tony supplied: welcome → demo → config → vibe → license → ready).
 *
 * Deliberate constraints:
 * - No animation libraries — CSS transitions + staged `animation-delay` only, like the rest of the app.
 *   The exception is Act 2's synthetic cursor (OnboardingDemoScene), which needs a per-frame
 *   projection CSS cannot express — a small rAF loop over lib/synthetic-cursor.ts, not a dependency.
 *   Act 1's Métis wordmark is static. No scramble.
 * - Scene 4's checks are REAL (getPermissions / requestPermissionsUpfront / asrBundled) — a row only
 *   ever shows "ready" when it is actually true. Never fake the magic moment.
 * - Act 2 (reveal) is the one deliberate exception to "never fake" — it drives Métis's REAL Bar/
 *   Copilot/Answer/QuickActions components with a scripted fake meeting (MQA-277), guarded so fake data
 *   can never persist and the demo can never see real data (MQA-278, @shared/demo-guard).
 * - Act 6 (Ready, MQA-283) is the terminal act: it finishes onboarding itself (marks `onboardingDone`)
 *   instead of handing off to the legacy provider/API-key step the way this component used to. That
 *   hop is gone from the narrative path entirely — the embedded-Cloudflare-default install
 *   (main/embedded-cloudflare-key.ts, MQA-273) already makes a fresh install `providerReady` with zero
 *   user action, so a mandatory config screen for something already configured was the dishonest part.
 *   Adding a personal provider key stays reachable as an OPTIONAL link from Ready, never a gate — see
 *   `ActReady` below and `onboarding-flow.ts` for the (independently tested) scene-transition rules.
 * - Act 3 (setup/Config, MQA-279) is "scan first, then present a completed configuration" — the
 *   Vibe-Island-teardown Config act's shape ("Everything's configured. No action needed."), kept honest
 *   by extending the SAME never-fake rule the other rows already follow to a new AI-readiness row
 *   (`aiRowStatus`, below): it reads `providerReady`/`provider` straight off the settings snapshot
 *   `publicSettings()` derives in main/index.ts, so it can never claim "Ready" while a real ask would
 *   still fail. The opt-out toggle on the screen row is the same rule in the other direction — it only
 *   ever appears because `screenAsk` is a real, always-on-by-default setting (ipc.ts), never invented.
 * - Self-contained: mounts in place of the legacy tour via App's onboarding gate; everything the host
 *   needs comes back through onDone.
 */
import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react'
import {
  AlertCircle,
  Check,
  CircleCheck,
  Cloud,
  FolderLock,
  KeyRound,
  MessageSquare,
  Mic,
  MonitorUp,
  Sparkles,
  TrendingUp,
  UserSearch,
  Cpu,
  CalendarDays,
  Handshake,
  Headphones,
  Phone,
  Presentation,
  Users,
  Volume2,
  VolumeX
} from 'lucide-react'
import type { ConversationMode, LocalModelSummary, PermissionStatus, ProfileRecoveryResult, PublicSettings } from '@shared/ipc'
import { PROVIDERS, type ProviderId } from '@shared/providers'
import { PERMISSIONS_POLL_MS } from '../state'
import { MetisMark } from './MetisMark'
import { AgentStatus, InlineOrb } from './AgentStatus'
import { OnboardingDemoScene, prefetchOnboardingDemoChunks } from './OnboardingDemoScene'
import { isWindows } from '../lib/keys'
import {
  ONBOARDING_PERSONAS,
  PERSONALIZE_LEAD,
  PERSONALIZE_MUST_PICK,
  PERSONALIZE_TITLE,
  type OnboardingPersonaId
} from '../lib/persona-vibe'
import { sceneAfterLicense, sceneAfterPersonalize, sceneAfterSetup, type OnboardingScene } from '../lib/onboarding-flow'
import { createOnboardingMusicBed, finishOnboardingAudioThen } from '../lib/onboarding-music'
import {
  closeOnboardingPortal,
  disposePortalAudio,
  playBarLand,
  playPortalOpen,
  requestBarLand
} from '../lib/onboarding-portal'
import {
  TELL_THE_ROOM_CHECKBOX,
  TELL_THE_ROOM_LEAD,
  TELL_THE_ROOM_QUOTE,
  TELL_THE_ROOM_READY,
  TELL_THE_ROOM_TITLE,
  TELL_THE_ROOM_WHY
} from '../lib/onboarding-tell-the-room'
import { ONBOARDING_HERO_VIDEO_SRC, playOnboardingVideo } from '../lib/onboarding-hero-video'
import { CONSTELLATION_CROSSFADE_MS, shouldMountConstellation } from '../lib/onboarding-constellation-spec'
import { OnboardingConstellation } from './OnboardingConstellation'
import { GooeySurface } from './GooeySurface'

// Same icon-per-mode mapping as the Settings → Personalize `ModePicker` (ModePicker.tsx) — one mode,
// one icon, everywhere it appears, rather than inventing a second icon language just for this scene.
const PERSONA_ICONS: Record<OnboardingPersonaId, typeof MessageSquare> = {
  general: MessageSquare,
  meeting: CalendarDays,
  sales: TrendingUp,
  recruiting: UserSearch,
  interview: Users,
  negotiation: Handshake,
  presentation: Presentation,
  support: Headphones,
  'cold-call': Phone
}

export interface OnboardingExperienceProps {
  /** Act 6 (Ready, MQA-283): awaited before Ready's optional "Add your own AI provider" link opens
   *  Settings, so the settings snapshot behind `onOpenAiSettings` always reflects a finished onboarding
   *  (`onboardingDone: true`) rather than racing an in-flight patch. OnboardingV2 below is the only
   *  caller and marks onboarding done inside this callback. */
  onDone: (result: { mode: ConversationMode; recordingConsent: boolean }) => void | Promise<void>
  /** Unused. The tour is mandatory. Kept so older callers still compile. */
  /** Ready's OPTIONAL "Add your own AI provider" link (never a gate) — opens Settings' AI tab. Omitted
   *  in contexts with no Settings surface to open (the link itself does not render without it). */
  onOpenAiSettings?: () => void
  /** Act 3's AI-readiness row (providerReady/provider) and screen-context opt-out toggle (screenAsk)
   *  read straight from the live settings snapshot — the same one OnboardingV2 already threads to the
   *  legacy provider step. Optional so a caller that only wants the narrative shell (or an older test)
   *  keeps compiling; both rows fall back to an honest "still checking" / no-toggle state without it. */
  settings?: PublicSettings
  /** Required to flip `screenAsk` from the opt-out toggle. Same function OnboardingV2 already calls to
   *  persist `mode`/`recordingConsent` out of this component. */
  patch?: (p: Partial<PublicSettings>) => void
}

/** Wave 5 — problem story (docs/ONBOARDING-EXPERIENCE.md Scene 2): staged lines, one at a time. */
const PROBLEM_STORY: string[] = [
  'Never lose the room.',
  'Métis remembers every word of the meeting.',
  'When the question lands, you already have the answer.'
]

// 'license' (Act 5, MQA-281/282) is deliberately NOT in GUIDED_SCENES below — see ActProgress's
// comment. It now appears between 'personalize' and 'ready' (Act 6's re-point, MQA-283, moved it from
// its original setup->license->personalize position to match the six-act canonical order — see
// onboarding-flow.ts), and only when settings.licenseGateEnabled is true (the non-default,
// self-hosted-license-server case); every other user's flow is byte-for-byte the four-scene guided
// sequence the MQA-201 regression test pins, now closed out by the 'ready' bookend below.
type Scene = OnboardingScene

// Hero and Ready are the bookends, not "steps" — like Onboarding.tsx's own slide 1/6 bookends, the dots
// only track the guided acts in between.
const GUIDED_SCENES: Scene[] = ['problem', 'reveal', 'setup', 'personalize']

// Lives in its own reserved-height row above the scene content (see the render below) rather than an
// absolute overlay — an overlay collided with scene headings that sit close to the top on taller scenes
// (e.g. "Your setup"'s 6 rows push the h2 up into where an absolutely-positioned dot row would sit).
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

function TellTheRoomCard({
  consent,
  onConsent
}: {
  consent: boolean
  onConsent: (next: boolean) => void
}): JSX.Element {
  return (
    <div className="onboard-glass onboard-tell-card">
      <h3>{TELL_THE_ROOM_TITLE}</h3>
      <p>{TELL_THE_ROOM_LEAD}</p>
      <p className="onboard-tell-quote">{TELL_THE_ROOM_QUOTE}</p>
      <p className="onboard-tell-why">{TELL_THE_ROOM_WHY}</p>
      <label className="onboard-tell-check">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => onConsent(e.target.checked)}
          className="onboard-tell-check-box no-drag accent-[var(--color-accent)]"
        />
        <span>{TELL_THE_ROOM_CHECKBOX}</span>
      </label>
    </div>
  )
}

/**
 * Act 1 — Welcome. The Métis mark and wordmark land and stay. The wordmark is static.
 * No scramble. The tagline may fade in once. Next starts the six-act tour.
 */
function OnboardingHeroVideo({
  videoRef,
  fading
}: {
  videoRef: Ref<HTMLVideoElement>
  fading?: boolean
}): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const el = typeof videoRef === 'object' && videoRef ? videoRef.current : null
    playOnboardingVideo(el)
    return () => {
      el?.pause()
    }
  }, [videoRef])
  if (prefersReducedMotion() || failed) return null
  return (
    <div className={'onboard-hero-video' + (fading ? ' onboard-hero-video--out' : '')} aria-hidden="true">
      <video
        ref={videoRef}
        muted
        loop
        playsInline
        autoPlay
        preload="metadata"
        src={ONBOARDING_HERO_VIDEO_SRC}
        onError={() => setFailed(true)}
      />
      <div className="onboard-hero-video-tint" />
    </div>
  )
}

function HeroWelcome({ onBegin }: { onBegin: () => void }): JSX.Element {
  return (
    <>
      <div className="hero-welcome relative z-10 flex flex-col items-center gap-5">
        <div className="scene-enter flex flex-col items-center gap-5">
          <div className="hero-mark onboard-mark-land" aria-hidden="true">
            <MetisMark size={96} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <h1
              className="hero-wordmark fade-up m-0 select-none"
              aria-label={WORDMARK}
              style={{ fontFamily: 'var(--font-ui)', animationDelay: '160ms', animationFillMode: 'both' }}
            >
              <span aria-hidden="true">{WORDMARK}</span>
            </h1>
            <p
              className="hero-tagline fade-up m-0 text-[14px] text-[color:var(--color-ink-2)]"
              style={{ animationDelay: '400ms', animationFillMode: 'both' }}
            >
              Your second brain in the corner.
            </p>
          </div>
        </div>
        <GooeySurface variant="cta">
        <button type="button" onClick={onBegin} className="onboard-cta no-drag focus-ring">
          Next
        </button>
        </GooeySurface>
        <p
          className="hero-byline onboard-glass onboard-glass-chip fade-up m-0 text-[10px] tracking-wide"
          style={{ animationDelay: '1300ms', animationFillMode: 'both' }}
        >
          Mantu ·{' '}
          <a
            href="https://www.linkedin.com/in/tonywalteur/"
            target="_blank"
            rel="noopener noreferrer"
            className="hero-byline-link no-drag focus-ring"
          >
            Tony Walteur
          </a>
        </p>
      </div>
    </>
  )
}

// 'restart' = permission is actually granted, but this same-session ScreenCaptureKit handle never saw it
// (macOS only applies a fresh Screen Recording grant to the NEXT launch) — needs a relaunch, not a prompt.
// 'blocked' = the OS holds an explicit Deny, which no prompt can undo — only the privacy pane can.
export type SetupRowState = 'checking' | 'ready' | 'action' | 'blocked' | 'restart' | 'skipped'

export interface SetupRow {
  key: string
  label: string
  icon: typeof Sparkles
  state: SetupRowState
  detail?: string
  progress?: number
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

/** Act 3's AI row (MQA-279): "Ready" only ever means what `providerReady` means everywhere else in the
 *  app — main/index.ts's `publicSettings()` computes it as the SAME gate askStart's attempt()/failover
 *  chain enforce before a real ask is allowed through, so this can never show competence the product
 *  cannot back up. The embedded-Cloudflare-default build (embedded-cloudflare-key.ts, MQA-273) makes
 *  `providerReady` true with zero user action, which is the case this row is written to narrate; a
 *  non-Cloudflare provider being ready (a returning/reset profile) still reads as ready, just named.
 *  Never gates onboarding's Continue — adding a personal key stays optional, exactly as it is once
 *  onboarding finishes (Settings → AI). */
export function aiRowStatus(
  settings: Pick<PublicSettings, 'providerReady' | 'provider'> | null | undefined
): { state: SetupRowState; detail: string } {
  if (!settings) return { state: 'checking', detail: '' }
  if (settings.providerReady) {
    return settings.provider === 'cloudflare'
      ? { state: 'ready', detail: "Ready: Métis's built-in Cloudflare, no key needed" }
      : { state: 'ready', detail: `Ready: ${PROVIDERS[settings.provider].label} configured` }
  }
  return { state: 'action', detail: 'not configured yet' }
}

/** Act 3 on-device model row. Never a dead missing-weights state. RAM-gated says so. */
export function localModelRowStatus(
  model:
    | Pick<LocalModelSummary, 'ready' | 'unavailableReason' | 'downloadProgress' | 'minTotalRamGB'>
    | null
    | undefined
): { state: SetupRowState; detail: string; progress?: number } {
  if (!model) return { state: 'checking', detail: '' }
  if (model.unavailableReason === 'insufficient-ram') {
    return {
      state: 'blocked',
      detail: `This Mac needs at least ${model.minTotalRamGB} GB of memory for the on-device model.`
    }
  }
  if (model.unavailableReason === 'downloading') {
    const pct = Math.round((model.downloadProgress ?? 0) * 100)
    return { state: 'action', detail: `Downloading ${pct}%`, progress: model.downloadProgress }
  }
  if (model.unavailableReason === 'download-failed') {
    return { state: 'action', detail: 'Download paused. Métis retries when the network is back.' }
  }
  if (model.unavailableReason === 'not-downloaded') {
    return { state: 'action', detail: 'Starting the on-device download…' }
  }
  if (model.ready) return { state: 'ready', detail: 'On-device model ready' }
  return { state: 'checking', detail: 'Checking the on-device model…' }
}

/** Act 3 — "scan first, then present a completed configuration": two DIFFERENT claims the scene makes,
 *  kept as one pure derivation so both stay honest and are each independently testable.
 *  `scanDone` only means every row has left 'checking' — safe to stop showing spinners and reveal the
 *  Listen-only caveat, which is true whether or not anything still needs action.
 *  `allReady` is the stronger "nothing to configure" claim (MQA-201's rule: never true from a row that
 *  never actually resolved, and never true while something still needs 'action'/'blocked'/'restart'). */
export interface SetupScanSummary {
  scanDone: boolean
  allReady: boolean
}
export function summarizeSetupRows(rows: SetupRow[]): SetupScanSummary {
  const scanDone = rows.length > 0 && rows.every((r) => r.state !== 'checking')
  const allReady = scanDone && rows.every((r) => r.state === 'ready' || r.state === 'skipped')
  return { scanDone, allReady }
}

/** Act 3's opt-out toggle (screenAsk) — a small local switch so this scene doesn't need to reach into
 *  Settings.tsx's `Toggle` (which is styled against the separate `--cl-*` settings-panel token set this
 *  onboarding shell never mounts). Same on/off mechanics, themed with the onboarding's own
 *  `--color-accent` tokens instead. */
function MiniToggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
      className={
        'no-drag focus-ring relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-150 ' +
        (on ? 'bg-[var(--color-accent)]' : 'bg-white/15')
      }
    >
      <span
        className={
          'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white transition-all duration-150 ' +
          (on ? 'left-[16px]' : 'left-[2px]')
        }
      />
    </button>
  )
}

/** Plain-language copy for every code the license server (or this client) can return. Duplicated from
 *  Settings.tsx's / LicenseGate.tsx's licenseErrorMessage on purpose — same reasoning both of those give
 *  for not importing one another: this scene has to keep working even if either of those chunks changes
 *  shape, and the map is a handful of lines. */
function licenseErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'invalid':
      return 'That license key was not recognized.'
    case 'revoked':
      return 'This license has been revoked.'
    case 'expired':
      return 'This license has expired.'
    case 'seat_limit_reached':
      return 'All seats on this license are in use.'
    case 'network':
      return 'Could not reach the license server. Check the server URL and your connection.'
    default:
      return code || 'Could not activate this license.'
  }
}

/**
 * Act 5 — License (MQA-281/282). Paste-key -> validate -> activate, in Métis's own voice — never a
 * price or a checkout: the copy is deliberately "the key you were given", matching license-server's
 * README ("no purchase, no price… keys are minted and handed out by an operator"). Rendered ONLY when
 * the caller (OnboardingExperience below) has already decided `settings.licenseGateEnabled` is true;
 * this component itself has no opinion on that, so it stays simple to reason about and to test.
 *
 * Never a dead end: Continue is ALWAYS enabled, activated or not. The real enforcement decision lives
 * in main's checkLicenseGrace() (consulted at boot by App.tsx's <LicenseGate/>, gated on the separate
 * LICENSE_ENFORCEMENT compile-time switch) — this scene's job is only to offer the paste-key flow at a
 * natural point in the narrative, never to become a second, onboarding-only gate that could strand a
 * trial user who has done nothing wrong.
 */
function ActLicense({
  settings,
  onContinue
}: {
  settings?: PublicSettings
  onContinue: () => void
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(settings?.licenseServerUrl || '')
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activated, setActivated] = useState(false)
  const serverId = useId()
  const keyId = useId()
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const activate = async (): Promise<void> => {
    const url = serverUrl.trim()
    const key = licenseKey.trim()
    if (!url || !key) return
    setActivating(true)
    setError(null)
    const r = await window.toto.licenseActivate({ serverUrl: url, licenseKey: key })
    if (!mountedRef.current) return
    setActivating(false)
    if (r.ok) {
      setLicenseKey('')
      setActivated(true)
    } else {
      setError(licenseErrorMessage(r.error))
    }
  }

  return (
    <div key="license" className="flex flex-col items-center gap-6">
      <div className="scene-enter flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-1.5">
        <p className="m-0 text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--color-ink-3)]">
          One more thing
        </p>
        <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">Activate your license</h2>
        <p className="m-0 max-w-[380px] text-[12.5px] leading-snug text-[color:var(--color-ink-2)]">
          Your organization runs its own license server. Paste the key you were given. No key yet? You
          can still continue on a trial and activate later from Settings.
        </p>
      </div>

      <div className="flex w-full max-w-[360px] flex-col gap-2 text-left">
        <label htmlFor={serverId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--color-ink-3)]">License server URL</span>
          <input
            id={serverId}
            value={serverUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://license.your-company.com"
            onChange={(e) => {
              setServerUrl(e.target.value)
              setError(null)
              setActivated(false)
            }}
            className="no-drag focus-ring rounded-[10px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
        </label>
        <label htmlFor={keyId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--color-ink-3)]">License key</span>
          <input
            id={keyId}
            type="password"
            value={licenseKey}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the key you were given"
            onChange={(e) => {
              setLicenseKey(e.target.value)
              setError(null)
              setActivated(false)
            }}
            className="no-drag focus-ring rounded-[10px] border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--color-destructive,#ff8080)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!error && activated && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--color-accent-2)]">
          <CircleCheck size={13} className="mt-px shrink-0" />
          <span>Activated. You're all set.</span>
        </div>
      )}

      </div>
      <div className="flex items-center gap-2">
        <GooeySurface variant="wait">
        <button
          type="button"
          onClick={() => void activate()}
          disabled={!serverUrl.trim() || !licenseKey.trim() || activating}
          className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[var(--color-accent)]/15 px-4 py-2 text-[12px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25 disabled:opacity-50"
        >
          {activating ? <InlineOrb kind="connecting" /> : <KeyRound size={13} />}
          Activate
        </button>
        </GooeySurface>
        <GooeySurface variant="cta">
        <button
          type="button"
          onClick={onContinue}
          className="onboard-cta no-drag focus-ring"
        >
          Continue
        </button>
        </GooeySurface>
      </div>
    </div>
  )
}

/** Fixed spark positions for the Ready ceremony (Act 6, MQA-283) — a handful of one-shot CSS motes
 *  around the mark, not a particle system. Positions are spread by hand (plain `left`/`top` offsets)
 *  rather than computed, so this is six literal, readable values instead of a runtime trig call for
 *  six static dots. Reduced motion is handled entirely by the blanket `prefers-reduced-motion` rule in
 *  styles.css: `.ready-spark`'s keyframes only ever animate opacity/transform (no `@property`-typed
 *  value), so the rule's 0ms duration reliably lands on the invisible end state. */
const READY_SPARKS: ReadonlyArray<{ x: number; y: number; delay: number }> = [
  { x: 34, y: -10, delay: 60 },
  { x: -30, y: -22, delay: 140 },
  { x: 22, y: 30, delay: 100 },
  { x: -34, y: 14, delay: 200 },
  { x: 4, y: -38, delay: 40 },
  { x: -8, y: 36, delay: 160 }
]

/**
 * Act 6 — Ready (MQA-283). The narrative's terminal act: a tasteful, Apple-grade celebratory beat (the
 * Métis mark gets one gleam sweep + a handful of one-shot spark motes — see READY_SPARKS/styles.css —
 * deliberately NOT VI's heavier confetti-cannon + collectible edition card; own copy, own restraint),
 * then the Métis equivalent of the teardown's honest "restart your sessions" last line: onboarding
 * finishes ONLY when this screen's own button is pressed, and even then Métis does not start listening
 * until Listen is pressed and the room has been told — the empty state is the truth, not a formality.
 *
 * `onOpenAiSettings` is OPTIONAL and never a gate: adding a personal provider key is reachable from
 * here (the embedded-Cloudflare-default install is already `providerReady` with nothing to add), and
 * pressing it still finishes onboarding first so the user lands in Settings, not back in onboarding.
 */
function ActReady({
  mode,
  onFinish,
  onOpenAiSettings
}: {
  mode: ConversationMode
  onFinish: () => Promise<void>
  onOpenAiSettings?: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const persona = ONBOARDING_PERSONAS.find((p) => p.id === (mode as OnboardingPersonaId))

  const finishAndOpenAiSettings = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await onFinish()
    onOpenAiSettings?.()
  }

  return (
    <div key="ready" className="onboard-ready-screen flex flex-col items-center">
      <div className="scene-enter flex flex-col items-center">
      <div className="ready-mark-wrap" aria-hidden="true">
        {READY_SPARKS.map((s, i) => (
          <span
            key={i}
            className="ready-spark"
            style={{ left: `calc(50% + ${s.x}px)`, top: `calc(50% + ${s.y}px)`, animationDelay: `${s.delay}ms` }}
          />
        ))}
        <MetisMark size={96} />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="m-0 text-[24px] font-semibold text-[color:var(--color-ink)]">You’re all set.</h2>
        {persona && (
          <p className="fade-up m-0 text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--color-accent-2)]">
            {persona.label} mode
          </p>
        )}
        {/* The honest empty-state — Métis's equivalent of the teardown's "restart your sessions" last
            line. Never softened into "you're good to go": nothing is captured until Listen is pressed
            AND the room has been told, which is exactly what the recording-consent checkbox back in
            personalize already committed the user to. */}
        <p className="m-0 max-w-[380px] text-[13px] leading-snug text-[color:var(--color-ink-2)]">
          {TELL_THE_ROOM_READY}
        </p>
        <p className="onboard-tell-quote onboard-tell-quote--echo fade-up">{TELL_THE_ROOM_QUOTE}</p>
      </div>
      </div>
      <GooeySurface variant="cta">
      <button
        type="button"
        onClick={() => void onFinish()}
        disabled={busy}
        className="onboard-cta no-drag focus-ring"
      >
        Get started
      </button>
      </GooeySurface>
      {onOpenAiSettings && (
        <button
          type="button"
          onClick={() => void finishAndOpenAiSettings()}
          disabled={busy}
          className="no-drag focus-ring text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)] disabled:opacity-50"
        >
          Add your own AI provider (optional, never required)
        </button>
      )}
    </div>
  )
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/** Bach Aria bed. Starts on exclusive mount. Retries on first click and Next. Scene changes do not stop it. */
function useOnboardingMusic(): {
  muted: boolean
  toggleMute: () => void
  audio: () => HTMLAudioElement | null
  start: () => void
  stop: () => void
  retryIfNeeded: () => void
} {
  const [muted, setMuted] = useState(false)
  const bedRef = useRef<ReturnType<typeof createOnboardingMusicBed> | null>(null)
  const pendingRetryRef = useRef(false)

  useEffect(() => {
    if (typeof Audio === 'undefined') return
    const bed = createOnboardingMusicBed()
    bedRef.current = bed
    return () => {
      bed.stop()
      bedRef.current = null
      disposePortalAudio()
    }
  }, [])

  useEffect(() => {
    bedRef.current?.setMuted(muted)
  }, [muted])

  const start = useCallback(() => {
    const playing = bedRef.current?.start()
    void playing?.then(
      () => {
        pendingRetryRef.current = false
      },
      () => {
        pendingRetryRef.current = true
      }
    )
  }, [])

  const retryIfNeeded = useCallback(() => {
    start()
  }, [start])

  const stop = useCallback(() => {
    bedRef.current?.stop()
  }, [])

  return {
    muted,
    toggleMute: () => setMuted((m) => !m),
    audio: () => bedRef.current?.element ?? null,
    start,
    stop,
    retryIfNeeded
  }
}

export function OnboardingExperience({
  onDone,
  onOpenAiSettings,
  settings,
  patch
}: OnboardingExperienceProps): JSX.Element {
  const music = useOnboardingMusic()
  const heroVideoRef = useRef<HTMLVideoElement>(null)
  const playHero = (restart = false): void => {
    playOnboardingVideo(heroVideoRef.current, { restart })
    music.start()
  }

  useEffect(() => {
    prefetchOnboardingDemoChunks()
    music.start()
    playPortalOpen(music.muted)
    music.start()
  }, [])
  const [scene, setScene] = useState<Scene>('hero')
  const [gridFailed, setGridFailed] = useState(false)
  const [heroFading, setHeroFading] = useState(false)
  useEffect(() => {
    if (!heroFading) return
    const id = window.setTimeout(() => setHeroFading(false), CONSTELLATION_CROSSFADE_MS)
    return () => window.clearTimeout(id)
  }, [heroFading])
  const [rows, setRows] = useState<SetupRow[]>([])
  const [mode, setMode] = useState<ConversationMode | null>(null)
  // Recording-consent gate (CMO-QA #1). Finish is blocked until this checkbox is checked on Ready.
  // There is no skip scene and no skip-the-tour hatch.
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
      { key: 'screen', label: 'Screen context', icon: MonitorUp, state: 'checking' },
      // Act 3 (MQA-279): AI readiness, derived from the SAME `providerReady`/`provider` publicSettings()
      // computes for every other gate in the app — see `aiRowStatus` above.
      { key: 'ai', label: 'Métis AI', icon: Cloud, state: 'checking' },
      { key: 'local', label: 'On-device model', icon: Cpu, state: 'checking' }
    ]
    setRows(base)
    screenGrantedRef.current = null
    const set = (key: string, state: SetupRowState, detail?: string, progress?: number): void => {
      if (!live) return
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, state, detail, progress } : r)))
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
      // AI readiness has no OS prompt to fire and no permission to live-poll — `providerReady` is
      // already a settled fact by the time this scene mounts (main seeds the embedded Cloudflare
      // credential, if any, before the first window even shows), so one staged resolution is enough.
      await delay(350)
      const ai = aiRowStatus(settings)
      set('ai', ai.state, ai.detail)
      const models = await window.toto.localModelsList().catch(() => [])
      const local =
        models.find((m) => m.unavailableReason === 'downloading') ??
        models.find((m) => m.id === settings?.localLlm.modelId) ??
        models[0]
      const lm = localModelRowStatus(local)
      set('local', lm.state, lm.detail, lm.progress)
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
      const models = await window.toto.localModelsList().catch(() => [])
      if (!live) return
      const local =
        models.find((m) => m.unavailableReason === 'downloading') ??
        models.find((m) => m.id === settings?.localLlm.modelId) ??
        models[0]
      const lm = localModelRowStatus(local)
      setRows((rs) =>
        rs.map((r) => {
          if (r.key === 'local') return { ...r, state: lm.state, detail: lm.detail, progress: lm.progress }
          if (!perms) return r
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
  }, [scene, settings?.localLlm.modelId])

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

  // Act 6 (Ready, MQA-283): this is now the narrative's actual finish — invoked from the Ready scene's
  // CTA, not personalize's Start (which now only advances to license/ready, see sceneAfterPersonalize).
  // Returns a promise so Ready's optional provider link can await it before opening Settings.
  const finish = async (): Promise<void> => {
    if (doneRef.current || !consent || !mode) return
    doneRef.current = true
    await finishOnboardingAudioThen(
      () => {
        music.stop()
        disposePortalAudio()
      },
      async () => {
        await closeOnboardingPortal(music.muted, prefersReducedMotion())
        playBarLand(music.muted)
        requestBarLand()
        await onDone({ mode, recordingConsent: true })
      }
    )
  }

  const { scanDone, allReady } = summarizeSetupRows(rows)
  // 'blocked' counts here for the same reason 'action' does — it was one of those states before it got
  // its own name, and Continue must not go primary while the mic is still denied. The AI row is
  // deliberately excluded — a personal provider key is available, never required (the embedded
  // Cloudflare default already answers), so it never blocks Continue the way mic/screen do.
  const needsPerms = rows.some(
    (r) => (r.key === 'mic' || r.key === 'screen') && (r.state === 'action' || r.state === 'blocked' || r.state === 'restart')
  )

  return (
    <div
      className="onboard-tour relative z-10 flex h-full w-full select-none flex-col items-center overflow-hidden px-10 text-center"
      onPointerDown={music.start}
    >
      {(scene === 'hero' || heroFading) && <OnboardingHeroVideo videoRef={heroVideoRef} fading={heroFading} />}
      {shouldMountConstellation(scene) && !gridFailed && (
        <OnboardingConstellation onUnavailable={() => setGridFailed(true)} />
      )}
      <button
        type="button"
        className="onboard-mute no-drag focus-ring"
        aria-label={music.muted ? 'Unmute music' : 'Mute music'}
        aria-pressed={music.muted}
        onClick={music.toggleMute}
      >
        {music.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <div className="flex h-9 shrink-0 items-center justify-center pt-3">
        <ActProgress scene={scene} />
      </div>
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6">
      {scene === 'hero' && (
        <HeroWelcome
          onBegin={() => {
            playOnboardingVideo(heroVideoRef.current, { restart: true })
            music.start()
            setScene('problem')
            setHeroFading(true)
          }}
        />
      )}

      {scene === 'problem' && (
        <div key="problem" className="flex flex-col items-center gap-8">
          <div className="scene-enter flex max-w-[420px] flex-col gap-3 text-left">
            {PROBLEM_STORY.map((line, i) => (
              <p
                key={line}
                className="fade-up m-0 text-[22px] font-medium leading-snug text-[color:var(--color-ink)]"
                style={{
                  animationDelay: `${200 + i * 1100}ms`,
                  animationFillMode: 'both'
                }}
              >
                {line}
              </p>
            ))}
          </div>
          <GooeySurface variant="cta">
          <button
            type="button"
            onClick={() => {
              playHero()
              setScene('reveal')
            }}
            className="onboard-cta no-drag focus-ring"
          >
            Continue
          </button>
          </GooeySurface>
        </div>
      )}

      {scene === 'reveal' && (
        <OnboardingDemoScene
          mode={mode}
          onSetMode={setMode}
          onContinue={() => {
            playHero()
            setScene('setup')
          }}
          onPlayVideo={() => {
            playHero()
          }}
        />
      )}

      {scene === 'setup' && (
        <div key="setup" className="flex flex-col items-center gap-6">
          <div className="scene-enter flex w-full flex-col items-center gap-6">
          <h2 className="m-0 text-[22px] font-semibold text-[color:var(--color-ink)]">Your setup</h2>
          <div className="flex w-full max-w-[440px] flex-col gap-2">
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="glass-strong fade-up onboard-pop-in flex items-start gap-3 rounded-[12px] px-3.5 py-2.5 text-left"
                style={{ animationDelay: `${i * 70}ms`, animationFillMode: 'both' }}
              >
                <r.icon size={16} className="mt-0.5 shrink-0 text-[color:var(--color-ink-2)]" />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[13px] text-[color:var(--color-ink)]">{r.label}</p>
                  {r.detail && <p className="m-0 text-[11px] text-[color:var(--color-ink-3)]">{r.detail}</p>}
                  {r.key === 'local' && r.progress != null && r.progress > 0 && r.progress < 1 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <AgentStatus kind="loading-model" size="inline" percent={Math.round(r.progress * 100)} />
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-[#9A2BF0]"
                          style={{ width: `${Math.round(r.progress * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
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
                          ? "Windows is blocking the microphone. Turn it back on in Privacy settings."
                          : "macOS won't ask again once you've said no. Turn it back on in Privacy settings."}
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
                  {/* Opt-out toggle framed as competence (Act 3 brief): screenAsk is a REAL, on-by-default
                      setting (ipc.ts) — never invented for this scene — so it's shown as "already on,
                      your call" rather than a setup step. Independent of the permission grant above: the
                      toggle flips the app's intent to ask, whether or not the OS has said yes yet. */}
                  {r.key === 'screen' && settings && patch && (
                    <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-white/10 pt-1.5">
                      <span className="text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                        Let Métis see your screen when you ask (on by default, your call).
                      </span>
                      <MiniToggle
                        on={settings.screenAsk}
                        onChange={(v) => patch({ screenAsk: v })}
                        label="Let Métis see your screen when you ask"
                      />
                    </div>
                  )}
                  {r.key === 'ai' && r.state === 'action' && (
                    <p className="mt-1 text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                      You'll add a provider key on the next step. Nothing else here needs one.
                    </p>
                  )}
                  {r.key === 'ai' && r.state === 'ready' && (
                    <p className="mt-1 text-[11px] leading-snug text-[color:var(--color-ink-3)]">
                      Add your own provider key anytime in Settings (optional, never required).
                    </p>
                  )}
                </div>
                {r.state === 'checking' && (
                  <AgentStatus kind="loading" size="inline" caption />
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
          {/* Métis's equivalent of Vibe Island's "restart your sessions" honest caveat (teardown, Config
              act) — but placed HERE, first, rather than saved for the final act, and reinforced again at
              Ready. True the moment scanning settles, regardless of allReady: nothing above changes when
              Métis is actually allowed to listen. */}
          {scanDone && (
            <p className="fade-up m-0 max-w-[360px] text-[11px] leading-snug text-[color:var(--color-ink-3)]">
              Métis only starts listening when you press Listen and tell the room. Nothing is captured before that.
            </p>
          )}
          </div>
          <div className="flex items-center gap-2">
            <GooeySurface variant="cta" muted={needsPerms}>
            <button
              type="button"
              // Act 6 re-point (MQA-283): setup always advances to personalize now — license (when
              // enabled) has moved to sit between personalize and ready. See onboarding-flow.ts.
              onClick={() => {
                playHero()
                setScene(sceneAfterSetup())
              }}
              className={
                'onboard-cta no-drag focus-ring ' + (needsPerms ? 'onboard-cta--muted' : '')
              }
            >
              Continue
            </button>
            </GooeySurface>
          </div>
        </div>
      )}

      {scene === 'personalize' && (
        <div key="personalize" className="onboard-act4 flex flex-col items-center">
          <div className="scene-enter flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <p className="onboard-act4-kicker">Last one</p>
            <h2 className="onboard-act4-title">{PERSONALIZE_TITLE}</h2>
            <p className="onboard-act4-must">{PERSONALIZE_MUST_PICK}</p>
            <p className="onboard-act4-lead">{PERSONALIZE_LEAD}</p>
          </div>
          <div className="onboard-persona-row" role="radiogroup" aria-label={PERSONALIZE_TITLE}>
            {ONBOARDING_PERSONAS.map((p) => {
              const Icon = PERSONA_ICONS[p.id]
              const selected = mode === p.id
              const card = (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setMode(p.id)}
                  className={'onboard-persona no-drag focus-ring' + (selected ? ' is-selected' : '')}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon size={13} className="text-[color:var(--color-ink)]" />
                    <p className="onboard-persona-label">{p.label}</p>
                  </div>
                  <p className="onboard-persona-vibe">{p.vibe}</p>
                  <p className="onboard-persona-changes">{p.changes}</p>
                </button>
              )
              return selected ? (
                <GooeySurface key={p.id} variant="select">
                  {card}
                </GooeySurface>
              ) : (
                <span key={p.id} className="onboard-persona-slot">
                  {card}
                </span>
              )
            })}
          </div>
          <div className="flex flex-col items-center gap-4">
            <TellTheRoomCard consent={consent} onConsent={setConsent} />
          </div>
          </div>
          <GooeySurface variant="cta" muted={!consent || !mode}>
          <button
            type="button"
            // Act 6 re-point (MQA-283): advances to license (only if enabled) or straight to Ready —
            // never finishes here directly any more. See onboarding-flow.ts.
            onClick={() => {
              if (!consent || !mode) return
              playHero()
              setScene(sceneAfterPersonalize(settings?.licenseGateEnabled))
            }}
            disabled={!consent || !mode}
            className={'onboard-cta no-drag focus-ring' + (consent && mode ? '' : ' onboard-cta--muted')}
          >
            Continue
          </button>
          </GooeySurface>
        </div>
      )}

      {/* Act 5 (MQA-281/282), re-pointed after personalize by Act 6 (MQA-283) — skipped ENTIRELY when
          settings.licenseGateEnabled is false (the default): personalize's Continue button above only
          ever routes here when that setting is already true, so a normal user (licensing off) never
          sees this scene render, not even for a frame. */}
      {scene === 'license' && (
        <ActLicense
          settings={settings}
          onContinue={() => {
            playHero()
            setScene(sceneAfterLicense())
          }}
        />
      )}

      {scene === 'ready' && mode && (
        <ActReady mode={mode} onFinish={finish} onOpenAiSettings={onOpenAiSettings} />
      )}
      </div>
    </div>
  )
}

/**
 * First-run flow. Finishes onboarding at Ready Get started.
 * The tour is mandatory. Does not mount Onboarding.tsx.
 */
export function OnboardingV2({
  settings,
  patch,
  onOpenAiSettings,
  onDone
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
  return (
    <OnboardingExperience
      settings={settings}
      patch={patch}
      onOpenAiSettings={onOpenAiSettings}
      onDone={async ({ mode, recordingConsent }) => {
        await patch({ mode, recordingConsent, onboardingDone: true, onboardingDoneAt: Date.now() })
        onDone()
      }}
    />
  )
}
