import { useCallback, useEffect, useId, useRef, useState, Suspense, type Ref, useLayoutEffect } from 'react'
import { bundleFailureUserMessage, isRepairRequiredBundleMessage, isRetryableBundleMessage } from '@shared/bundle-response'
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
import type {
  AsrAssetsStatus,
  ConversationMode,
  LocalModelSummary,
  PermissionStatus,
  ProfileRecoveryResult,
  PublicSettings
} from '@shared/ipc'
import { MEETING_AUDIO_SCREEN_LABEL } from '../../lib/screen-permission-copy'
import { ScreenSetupActions, resumeSetupAtLoad, screenRowStatus, useScreenSetup } from '../../components/OnboardingScreenSetup'
import type { OverlayLayout } from '@shared/overlay-chrome'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { PROVIDERS, type ProviderId } from '@shared/providers'
import { PERMISSIONS_POLL_MS } from '../../state'
import { InlineOrb } from '../../components/AgentStatus'
import { MetisMark } from '../../components/MetisMark'
import { prefetchOnboardingDemoChunks } from '../../lib/onboarding-demo-prefetch'
// Keep the scripted demo ready when the user reaches Reveal; its heavy Answer/Copilot
// children remain lazy inside the demo scene.
import { OnboardingDemoScene } from '../../components/OnboardingDemoScene'
import { OnboardingAppearance } from '../../components/OnboardingAppearance'
import { KineticGrid } from '../../components/onboarding/KineticGrid'
import { shouldMountKineticGrid } from '../../lib/onboarding-kinetic-grid'
import { isWindows } from '../../lib/keys'
import { ONBOARDING_PERSONAS, type OnboardingPersonaId } from '../../lib/persona-vibe'
import {
  canMarkOnboardingDone,
  sceneAfterAppearance,
  sceneAfterLicense,
  sceneAfterPersonalize,
  sceneAfterReveal,
  sceneAfterSetup,
  type OnboardingScene
} from '../../lib/onboarding-flow'
import {
  appearanceSettingsPatch,
  resolveOnboardingPlacementSync,
  saveOnboardingAppearanceChoice,
  seedOnboardingAppearance,
  seedOnboardingPlacement
} from '../../lib/onboarding-appearance'
import { persistOverlayPlacement } from '../../lib/overlay-placement-save'
import { onboardingReadinessCopy } from '../../lib/onboarding-readiness-copy'
import {
  createOnboardingCompletionFlow,
  ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE,
  encryptedProfileRecoveryFailureMessage,
  isEncryptedProfileRecoveryError,
  ONBOARDING_COMPLETION_STALL_MS,
  persistOnboardingCompletion,
  type OnboardingCompletionOutcome,
  type OnboardingCompletionState
} from '../../lib/onboarding-completion'
import { createOnboardingMusicBed, haltAllOnboardingAudio, lockOnboardingAudio } from '../../lib/onboarding-music'
import { closeOnboardingPortal, disposePortalAudio, playBarLand, playPortalOpen, requestBarLand, requestOnboardingPortalOpen } from '../../lib/onboarding-portal'
import {
  TELL_THE_ROOM_CHECKBOX,
  TELL_THE_ROOM_LEAD,
  TELL_THE_ROOM_QUOTE,
  TELL_THE_ROOM_READY,
  TELL_THE_ROOM_TITLE,
  TELL_THE_ROOM_WHY
} from '../../lib/onboarding-tell-the-room'
import {
  ONBOARDING_HERO_POSTER_SRC,
  ONBOARDING_HERO_VIDEO_SRC,
  playOnboardingVideo,
  preloadOnboardingHeroVideo,
  resolveOnboardingHeroVideoSrc
} from '../../lib/onboarding-hero-video'
export { speechPackAllowsEnsure, speechPackSetupRowVisible } from '../../lib/local-speech-pack-policy'
import { speechPackAllowsEnsure, speechPackSetupRowVisible, type LocalSpeechPackSetting } from '../../lib/local-speech-pack-policy'

export const PERSONA_ICONS: Record<OnboardingPersonaId, typeof MessageSquare> = {
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
  /** Act 6 (Ready, MQA-283): durable completion then one-way window replacement. The destination is
   *  carried through the trusted main-process launch path so the optional AI action opens Settings in
   *  the replacement window, not a BrowserWindow about to be destroyed. */
  onDone: (result: { mode: ConversationMode; recordingConsent: boolean; destination: 'answer' | 'settings' }) => void | Promise<void>
  /** Unused. Skip is gone — the tour must be completed. */
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
  patch?: (p: Partial<PublicSettings>) => Promise<PublicSettings>
  /** Finish controls wait for the first authorization verdict, so required SSO never has a silent save failure. */
  authReady?: boolean
  /** Creates a fresh local profile only after the native confirmation archives the existing encrypted one. */
  recoverEncryptedProfile?: () => Promise<ProfileRecoveryResult>
}

/** Wave 5 — problem story (docs/ONBOARDING-EXPERIENCE.md Scene 2): staged lines, one at a time. */
export const PROBLEM_STORY: string[] = [
  "You're in the meeting.",
  'The question lands on you.',
  'You know that you know it.',
  '…and the moment passes.'
]

// 'license' is deliberately NOT in GUIDED_SCENES. It only appears after personalize when
// settings.licenseGateEnabled is true. Dots track the guided acts Example walks:
// problem → reveal → appearance → setup → personalize. See onboarding-flow.ts.
type Scene = OnboardingScene

// Hero and Ready are the bookends. Dots track the guided acts in between.
const GUIDED_SCENES: Scene[] = ['problem', 'reveal', 'appearance', 'setup', 'personalize']

// Lives in its own reserved-height row above the scene content (see the render below) rather than an
// absolute overlay — an overlay collided with scene headings that sit close to the top on taller scenes
// (e.g. "Your setup"'s 6 rows push the h2 up into where an absolutely-positioned dot row would sit).
export function ActProgress({ scene }: { scene: Scene }): JSX.Element | null {
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

export function TellTheRoomCard({
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
export function OnboardingHeroVideo({
  videoRef
}: {
  videoRef: Ref<HTMLVideoElement>
}): JSX.Element {
  const [videoFailed, setVideoFailed] = useState(false)
  // FITO-185-Y: poster/UI first. The 8.9MB hero mp4 must not contend for first paint.
  // Video mounts after a short idle; pending <video> stays opacity 0 until a decoded frame.
  const [allowVideo, setAllowVideo] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const markReady = useCallback(() => setVideoReady(true), [])
  useEffect(() => {
    if (prefersReducedMotion()) return
    const start = (): void => setAllowVideo(true)
    const t = window.setTimeout(start, 480)
    return () => window.clearTimeout(t)
  }, [])
  useEffect(() => {
    if (!allowVideo || prefersReducedMotion()) return
    preloadOnboardingHeroVideo()
    const el = typeof videoRef === 'object' && videoRef ? videoRef.current : null
    if (el) {
      el.load()
      void el.play().catch(() => {})
    }
    // FITO-185-V: exclusive can decode without firing loadeddata; promote once frames advance.
    const fallbackId = window.setTimeout(() => {
      const v = typeof videoRef === 'object' && videoRef ? videoRef.current : null
      if (!v) return
      if (v.currentTime > 0 || v.readyState >= 2) setVideoReady(true)
    }, 800)
    return () => {
      window.clearTimeout(fallbackId)
      const v = typeof videoRef === 'object' && videoRef ? videoRef.current : null
      v?.pause()
    }
  }, [allowVideo, videoRef])
  return (
    <div className="onboard-hero-video" aria-hidden="true">
      <img className="onboard-hero-poster" src={ONBOARDING_HERO_POSTER_SRC} alt="" decoding="sync" fetchPriority="high" />
      {allowVideo && !prefersReducedMotion() && !videoFailed && (
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          poster={ONBOARDING_HERO_POSTER_SRC}
          src={resolveOnboardingHeroVideoSrc(ONBOARDING_HERO_VIDEO_SRC)}
          className={videoReady ? 'onboard-hero-video--ready' : 'onboard-hero-video--pending'}
          onLoadedData={markReady}
          onCanPlay={markReady}
          onPlaying={markReady}
          onTimeUpdate={markReady}
          onError={() => setVideoFailed(true)}
        />
      )}
      <div className="onboard-hero-video-tint" />
    </div>
  )
}

export function HeroWelcome({ onBegin }: { onBegin: () => void }): JSX.Element {
  const onBeginRef = useRef(onBegin)
  onBeginRef.current = onBegin
  useLayoutEffect(() => {
    requestOnboardingPortalOpen()
    const boot = document.getElementById('act1-boot-chrome')
    boot?.remove()
    const w = window as Window & { __act1BootNextQueued?: boolean }
    if (w.__act1BootNextQueued) {
      w.__act1BootNextQueued = false
      onBeginRef.current()
    }
    const onQueued = (): void => {
      w.__act1BootNextQueued = false
      onBeginRef.current()
    }
    window.addEventListener('act1-boot-next', onQueued)
    return () => window.removeEventListener('act1-boot-next', onQueued)
  }, [])
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
              Your on-device meeting copilot.
            </p>
          </div>
        </div>
        <button type="button" onClick={onBegin} className="onboard-cta no-drag focus-ring">
          Next
        </button>
        <p
          className="hero-byline onboard-glass onboard-glass-chip fade-up m-0 text-[10px] tracking-wide"
          style={{ animationDelay: '1300ms', animationFillMode: 'backwards' }}
        >
          Mantu ·{' '}
          <a
            href="https://www.linkedin.com/in/tonywalteur/"
            target="_blank"
            rel="noopener noreferrer"
            className="hero-byline-link no-drag focus-ring"
          >
            Metis Maintainers
          </a>
        </p>
      </div>
    </>
  )
}

// 'restart' = permission is actually granted, but this same-session ScreenCaptureKit handle never saw it
// (macOS only applies a fresh Screen Recording grant to the NEXT launch) — needs a relaunch, not a prompt.
// 'blocked' = the OS holds an explicit Deny, which no prompt can undo — only the privacy pane can.

import { licenseErrorMessage } from './onboarding-setup'
export function ActLicense({
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
    <div key="license" className="scene-enter flex flex-col items-center gap-6">
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

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void activate()}
          disabled={!serverUrl.trim() || !licenseKey.trim() || activating}
          className="no-drag focus-ring flex items-center gap-1.5 rounded-full bg-[#9A2BF0] px-4 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {activating ? <InlineOrb kind="connecting" /> : <KeyRound size={13} />}
          Activate
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="onboard-cta no-drag focus-ring"
        >
          Continue
        </button>
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
export function ActReady({
  mode,
  onFinish,
  onOpenAiSettings,
  asrReady,
  aiReady,
  asrHint,
  asrProgress,
  showAsrRetry,
  onRetryAsr,
  recoverEncryptedProfile,
  authReady = true
}: {
  mode: ConversationMode
  onFinish: (destination: 'answer' | 'settings') => Promise<boolean>
  onOpenAiSettings?: () => void
  asrReady: boolean
  aiReady: boolean
  asrHint: string
  asrProgress?: number
  showAsrRetry: boolean
  onRetryAsr: () => void
  recoverEncryptedProfile?: () => Promise<ProfileRecoveryResult>
  authReady?: boolean
}): JSX.Element {
  const [completion, setCompletion] = useState<OnboardingCompletionState>({ busy: false, error: null })
  const [completionStalled, setCompletionStalled] = useState(false)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)
  const completionFlowRef = useRef<ReturnType<typeof createOnboardingCompletionFlow> | null>(null)
  if (!completionFlowRef.current) completionFlowRef.current = createOnboardingCompletionFlow(setCompletion)
  const persona = ONBOARDING_PERSONAS.find((p) => p.id === (mode as OnboardingPersonaId))
  // P0 nuclear: ASR must never pin Get started forever — files can finish in Settings.
  // Auth boot can still mute briefly; Ready screen shows Checking copy + Retry.
  const blocked = completion.busy || recoveryBusy || !authReady
  const readinessCopy = onboardingReadinessCopy(asrReady, aiReady)

  useEffect(() => {
    if (!completion.busy) {
      setCompletionStalled(false)
      return
    }
    const timer = window.setTimeout(() => setCompletionStalled(true), ONBOARDING_COMPLETION_STALL_MS)
    return () => window.clearTimeout(timer)
  }, [completion.busy])

  const attemptFinish = async (destination: 'answer' | 'settings'): Promise<OnboardingCompletionOutcome> => {
    if (!authReady) return 'blocked'
    return (await completionFlowRef.current?.attempt(async () => {
      try {
        return await onFinish(destination)
      } catch (error) {
        const canRecover = !!recoverEncryptedProfile && isEncryptedProfileRecoveryError(error)
        setRecoveryAvailable(canRecover)
        if (canRecover) setRecoveryMessage(null)
        throw error
      }
    })) ?? 'blocked'
  }

  const recoverProfileAndRetry = async (): Promise<void> => {
    if (!recoverEncryptedProfile || recoveryBusy) return
    setRecoveryBusy(true)
    setRecoveryMessage(null)
    try {
      const result = await recoverEncryptedProfile()
      if (!result.ok) {
        setRecoveryMessage(encryptedProfileRecoveryFailureMessage(result))
        return
      }
      const outcome = await attemptFinish('answer')
      if (outcome === 'completed') setRecoveryAvailable(false)
    } catch {
      setRecoveryMessage(ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE)
    } finally {
      setRecoveryBusy(false)
    }
  }

  return (
    <div key="ready" className="scene-enter onboard-ready-screen flex flex-col items-center">
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
        <h2 className="m-0 text-[24px] font-semibold text-[color:var(--color-ink)]">{readinessCopy.title}</h2>
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
        <p className="m-0 max-w-[380px] text-[12px] leading-snug text-[color:var(--color-ink-3)]">
          {readinessCopy.aiHint}
        </p>
        <p className="onboard-tell-quote onboard-tell-quote--echo fade-up">{TELL_THE_ROOM_QUOTE}</p>
      </div>
      {!asrReady && (
        <div className="flex w-full max-w-[360px] flex-col items-center gap-1.5">
          <p className="m-0 text-[11px] leading-snug text-[color:var(--color-ink-3)]">{asrHint}</p>
          {asrProgress != null && asrProgress > 0 && asrProgress < 1 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.round(asrProgress * 100)}%` }} />
            </div>
          )}
          {showAsrRetry && (
            <button
              type="button"
              onClick={onRetryAsr}
              className="no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25"
            >
              Try again
            </button>
          )}
        </div>
      )}
      {!authReady && (
        <p className="m-0 max-w-[360px] text-center text-[11px] leading-snug text-[color:var(--color-ink-3)]">
          Checking your organization access before setup can finish…
        </p>
      )}
      <button
        type="button"
        onClick={() => attemptFinish('answer')}
        disabled={blocked}
        className={'onboard-cta no-drag focus-ring' + (blocked ? ' onboard-cta--muted' : '')}
      >
        {completion.busy ? 'Saving…' : 'Get started'}
      </button>
      {onOpenAiSettings && (
        <button
          type="button"
          onClick={() => attemptFinish('settings')}
          disabled={blocked}
          className="no-drag focus-ring text-[11px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)] disabled:opacity-50"
        >
          {readinessCopy.aiAction}
        </button>
      )}
      {completion.error && (
        <p role="alert" className="m-0 max-w-[360px] text-[11px] leading-snug text-[color:var(--color-danger)]">
          {completion.error}
        </p>
      )}
      {completionStalled && (
        <div role="alert" className="flex max-w-[360px] flex-col items-center gap-2 rounded-xl border border-[var(--color-accent)]/35 bg-[var(--color-accent-soft)]/35 p-3 text-center text-[11px] leading-snug text-[color:var(--color-ink-2)]">
          <p className="m-0">
            Métis is still checking whether your setup was saved. Don’t submit it again. Restart Métis to check the saved result.
          </p>
          <button
            type="button"
            onClick={() => void window.toto.relaunch().catch(() => {})}
            className="no-drag focus-ring rounded-lg bg-[#9A2BF0] px-3 py-1.5 text-[11px] font-medium text-white hover:brightness-110"
          >
            Restart Métis
          </button>
        </div>
      )}
      {recoveryAvailable && recoverEncryptedProfile && (
        <div className="flex max-w-[360px] flex-col items-center gap-2 rounded-xl border border-[var(--color-accent)]/35 bg-[var(--color-accent-soft)]/35 p-3 text-[11px] leading-snug text-[color:var(--color-ink-2)]">
          <p className="m-0">
            Métis can archive the encrypted profile on this device and create a new local profile. Nothing is deleted.
          </p>
          <button
            type="button"
            onClick={() => void recoverProfileAndRetry()}
            disabled={recoveryBusy}
            className="no-drag focus-ring inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {recoveryBusy ? <InlineOrb kind="loading" /> : <KeyRound size={13} />}
            {recoveryBusy ? 'Creating new local profile…' : 'Create new local profile & retry'}
          </button>
          {recoveryMessage && <p role="alert" className="m-0 text-[color:var(--color-danger)]">{recoveryMessage}</p>}
        </div>
      )}
    </div>
  )
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/** Bach Aria bed. Starts on exclusive mount. Retries on first click and Next. Scene changes do not stop it. */
export function useOnboardingMusic(): {
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
    // Never create the bed during render — Strict Mode double-invoke leaks a second Aria.
    if (typeof Audio !== 'undefined') {
      bedRef.current = createOnboardingMusicBed()
    }
    return () => {
      haltAllOnboardingAudio()
      bedRef.current?.stop()
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
