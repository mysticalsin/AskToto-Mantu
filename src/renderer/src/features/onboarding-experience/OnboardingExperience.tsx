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
import { speechPackAllowsEnsure, speechPackSetupRowVisible, type LocalSpeechPackSetting } from '../../lib/local-speech-pack-policy'

import { OnboardingExperienceLayout } from './OnboardingExperienceLayout'
import {
  ActLicense,
  ActProgress,
  ActReady,
  HeroWelcome,
  OnboardingHeroVideo,
  PROBLEM_STORY,
  TellTheRoomCard,
  prefersReducedMotion,
  useOnboardingMusic,
  type OnboardingExperienceProps
} from './onboarding-scenes'
import {
  ASR_SETUP_FAIL_OPEN_MS,
  asrAssetsRowStatus,
  asrEnsureFailureStatus,
  asrRowNeedsRepair,
  asrRowNeedsRetry,
  asrStatusIsReady,
  firstRunCanFinish,
  localModelRowStatus,
  micRowStatus,
  setupAsrBlocksContinue,
  setupContinueLabel,
  setupRowLoadingPercent,
  setupRowsForSpeechPackPolicy,
  summarizeSetupRows,
  type SetupRow,
  type SetupRowState,
  aiRowStatus,
  IDLE_ASR_STATUS
} from './onboarding-setup'

export { speechPackAllowsEnsure, speechPackSetupRowVisible } from '../../lib/local-speech-pack-policy'
export {
  ASR_SETUP_FAIL_OPEN_MS,
  ASR_SETUP_RETRY_TIMEOUT_MS,
  aiRowStatus,
  asrAssetsRowStatus,
  asrEnsureFailureStatus,
  asrRowNeedsRepair,
  asrRowNeedsRetry,
  asrStatusIsReady,
  firstRunCanFinish,
  licenseErrorMessage,
  localModelRowStatus,
  micRowStatus,
  setupAsrBlocksContinue,
  setupContinueLabel,
  setupRowLoadingPercent,
  setupRowsForSpeechPackPolicy,
  summarizeSetupRows,
  type SetupRow,
  type SetupRowState
} from './onboarding-setup'
export type { OnboardingExperienceProps } from './onboarding-scenes'

export function OnboardingExperience({
  onDone,
  onOpenAiSettings,
  settings,
  patch,
  recoverEncryptedProfile,
  authReady
}: OnboardingExperienceProps): JSX.Element {
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const music = useOnboardingMusic()
  const heroVideoRef = useRef<HTMLVideoElement>(null)
  const playHero = (): void => {
    // Background media is optional. A synchronous decoder/playback failure must never swallow
    // the same click's scene transition (especially Act 2's user-controlled Next).
    try { music.start() } catch { /* continue without music */ }
    try { playOnboardingVideo(heroVideoRef.current) } catch { /* continue without video */ }
  }

  useEffect(() => {
    // FITO-185-T: do not start Goldberg until Act 1 is interactive (window focused), so music
    // cannot play over a behind-Finder void. Main showForExclusiveOnboarding focuses first.
    let started = false
    let focusFallbackId: ReturnType<typeof setTimeout> | undefined
    const kickMusic = (): void => {
      if (started) return
      started = true
      if (focusFallbackId != null) clearTimeout(focusFallbackId)
      music.start()
      playPortalOpen(music.muted)
      music.start()
    }
    const onFocus = (): void => {
      kickMusic()
    }
    if (typeof document !== 'undefined' && document.hasFocus()) {
      kickMusic()
    } else {
      window.addEventListener('focus', onFocus)
      // Headless / autoplay-policy fallback — still prefer focus when main activates exclusive.
      focusFallbackId = setTimeout(kickMusic, 2500)
    }
    // Demo/Bar/Three chunks: never compete with Act 1 lady+planet first paint.
    const warm = (): void => {
      prefetchOnboardingDemoChunks()
    }
    let idleId: number | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      idleId = w.requestIdleCallback(warm, { timeout: 2500 })
    } else {
      timeoutId = setTimeout(warm, 2000)
    }
    return () => {
      window.removeEventListener('focus', onFocus)
      if (focusFallbackId != null) clearTimeout(focusFallbackId)
      if (idleId != null) w.cancelIdleCallback?.(idleId)
      if (timeoutId != null) clearTimeout(timeoutId)
    }
  }, [])

  // FITO-185-L: force portal mask open on Act 1 mount immediately — a closed 120×36 slit
  // masks the lady+planet to invisible until animation completes (or stalls forever).
  useLayoutEffect(() => {
    requestOnboardingPortalOpen()
  }, [])
  const [scene, setScene] = useState<OnboardingScene>(() => (resumeSetupAtLoad() ? 'setup' : 'hero'))
  const [rows, setRows] = useState<SetupRow[]>([])
  // M2-0429: the latest permission snapshot and the real loopback self-test behind the screen row.
  const screenSetup = useScreenSetup(scene === 'setup')
  const [mode, setMode] = useState<ConversationMode>('general')
  const [appearance, setAppearance] = useState<OverlayLayout>(() => seedOnboardingAppearance(settings))
  const [placement, setPlacement] = useState<OverlayPlacement>(() => seedOnboardingPlacement(settings))
  const [appearanceSave, setAppearanceSave] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const placementUserSelectedRef = useRef(false)
  const placementManaged = Boolean(settings?.managedKeys?.includes('overlayPlacement'))
  useEffect(() => {
    const next = resolveOnboardingPlacementSync({
      current: placement,
      incoming: settings?.overlayPlacement,
      userSelected: placementUserSelectedRef.current,
      managed: placementManaged
    })
    if (next) setPlacement(next)
  }, [placement, placementManaged, settings?.overlayPlacement])
  const pickAppearance = async (id: OverlayLayout): Promise<void> => {
    if (appearanceSave.busy || appearanceLocked) return
    if (!patch) {
      setAppearance(id)
      return
    }
    setAppearanceSave({ busy: true, error: null })
    try {
      const saved = await saveOnboardingAppearanceChoice(
        () => patch(appearanceSettingsPatch(id)),
        (next) => next.overlayLayout === id
      )
      if (!saved) throw new Error('appearance was not saved')
      setAppearance(id)
    } catch {
      setAppearanceSave({ busy: false, error: "Métis couldn't save this appearance. Try again." })
      return
    }
    setAppearanceSave({ busy: false, error: null })
  }
  const pickPlacement = async (id: OverlayPlacement): Promise<void> => {
    if (appearanceSave.busy || placementLocked) return
    const previousPlacement = placement
    const previousAppearance = appearance
    const nextAppearance = resolveOverlayPresentation({ layout: appearance, placement: id }).layout
    const previousPlacementWasUserSelected = placementUserSelectedRef.current
    placementUserSelectedRef.current = true
    setPlacement(id)
    setAppearance(nextAppearance)
    if (!patch) {
      return
    }
    setAppearanceSave({ busy: true, error: null })
    try {
      const saved = await persistOverlayPlacement(id, appearance, patch)
      if (!saved) throw new Error('placement was not saved')
    } catch {
      placementUserSelectedRef.current = previousPlacementWasUserSelected
      setPlacement(previousPlacement)
      setAppearance(previousAppearance)
      setAppearanceSave({ busy: false, error: "Métis couldn't save this position. Try again." })
      return
    }
    setAppearanceSave({ busy: false, error: null })
  }
  const appearanceLocked = Boolean(settings?.managedKeys?.includes('overlayLayout'))
  const placementLocked = placementManaged
  // Recording-consent gate (CMO-QA #1). Finish is blocked until this checkbox is checked on Ready.
  const [consent, setConsent] = useState(false)
  const [asrStatus, setAsrStatus] = useState<AsrAssetsStatus>(IDLE_ASR_STATUS)
  /** Once true, Continue stays unlocked even if ASR poll returns loading. */
  const [setupAccessFailOpen, setSetupAccessFailOpen] = useState(false)
  const speechPackPolicy = settings?.localSpeechPack ?? 'offered'
  const speechPackBlocked = !speechPackAllowsEnsure(speechPackPolicy)
  const speechPackManaged = speechPackPolicy === 'required'
  const asrReady = speechPackBlocked || asrStatusIsReady(asrStatus)
  const asrRowBase = asrAssetsRowStatus(asrStatus, settings?.asrEngine)
  const asrRow = speechPackManaged
    ? { ...asrRowBase, detail: `${asrRowBase.detail} Managed by your organization.` }
    : asrRowBase
  const doneRef = useRef(false)

  useEffect(() => {
    if (speechPackBlocked) return
    let live = true
    const apply = (s: AsrAssetsStatus): void => {
      if (live) setAsrStatus(s)
    }
    void window.toto.asrAssetsEnsure().then(apply).catch((err) => apply(asrEnsureFailureStatus(err)))
    // A stalled setup must become actionable, but must not turn the final Ready action into a trap.
    const asrSetupTimeout = setTimeout(() => {
      if (!live) return
      setSetupAccessFailOpen(true)
      setAsrStatus((prev) => {
        if (prev.ready || prev.status === 'ready' || prev.status === 'error') return prev
        const message = 'Transcription setup needs attention. Try again to continue.'
        return { ready: false, status: 'error', progress: prev.progress || 0, label: message, error: message }
      })
    }, ASR_SETUP_FAIL_OPEN_MS)
    const poll = async (): Promise<void> => {
      const s = await window.toto.asrAssetsStatus().catch(() => null)
      if (!s) return
      // Never re-lock Continue: ignore non-terminal status once fail-open latched or already error.
      setAsrStatus((prev) => {
        if (prev.status === 'error' && s.status !== 'ready' && !s.ready) return prev
        if (prev.ready || prev.status === 'ready') return s.ready || s.status === 'ready' ? s : prev
        return s
      })
    }
    const interval = setInterval(() => void poll(), PERMISSIONS_POLL_MS)
    const unsub = window.toto.onImportAssetsProgress?.((d) => {
      apply({ ...d, ready: d.status === 'ready' })
    })
    return () => {
      live = false
      clearTimeout(asrSetupTimeout)
      clearInterval(interval)
      unsub?.()
    }
  }, [speechPackBlocked])
  const [restarting, setRestarting] = useState(false)
  useEffect(() => {
    if (scene !== 'setup') return
    const s = screenRowStatus(screenSetup.perms, screenSetup.check, isWindows)
    setRows((rs) => rs.map((r) => (r.key === 'screen' ? { ...r, state: s.state, detail: s.detail } : r)))
  }, [scene, screenSetup.perms, screenSetup.check])
  // P0: any post-hero scene must keep portal mask open (Example: after Next → black).
  useEffect(() => {
    if (scene === 'hero') return
    document.getElementById('act1-boot-chrome')?.remove()
    try {
      requestOnboardingPortalOpen()
    } catch {
      /* ignore */
    }
  }, [scene])

  // --- Setup scene: run the REAL checks the moment the scene mounts.
  useEffect(() => {
    if (scene !== 'setup') return
    let live = true
    const base = setupRowsForSpeechPackPolicy(speechPackPolicy)
    setRows(base)
    const set = (key: string, state: SetupRowState, detail?: string, progress?: number): void => {
      if (!live) return
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, state, detail, progress } : r)))
    }
    // Stagger the resolutions so each row visibly "lands" — but every verdict is real.
    void (async () => {
      const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      await delay(500)
      if (!speechPackBlocked) {
        void window.toto
          .asrAssetsEnsure()
          .then((s) => {
            if (live) setAsrStatus(s)
          })
          .catch((err) => {
            if (!live) return
            setAsrStatus(asrEnsureFailureStatus(err))
          })
        const asrStatus =
          (await Promise.race([
            window.toto.asrAssetsStatus().catch((err) => asrEnsureFailureStatus(err)),
            new Promise<AsrAssetsStatus>((r) =>
              setTimeout(
                () =>
                  r({
                    ready: false,
                    status: 'error',
                    progress: 0,
                    label: 'Transcription files are still downloading. You can continue and finish them in Settings.',
                    error: 'Transcription files are still downloading. You can continue and finish them in Settings.'
                  }),
                ASR_SETUP_FAIL_OPEN_MS
              )
            )
          ])) || asrEnsureFailureStatus()
        if (live) {
          if (asrStatus.status === 'error' || !asrStatus.ready) setSetupAccessFailOpen(true)
          setAsrStatus(asrStatus)
        }
        const asr = asrAssetsRowStatus(asrStatus, settingsRef.current?.asrEngine)
        const detail = speechPackManaged ? `${asr.detail} Managed by your organization.` : asr.detail
        set('asr', asr.state, detail, asr.progress)
      }
      await delay(450)
      set('brain', 'ready', isWindows ? 'stays on this PC' : 'stays on this Mac')
      await delay(450)
      const perms = await Promise.race([
        window.toto.getPermissions().catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), ASR_SETUP_FAIL_OPEN_MS))
      ])
      const mic = micRowStatus(perms?.microphone)
      set('mic', mic.state, mic.detail)
      await delay(350)
      // Windows has no per-app Screen Recording permission, so screenRowStatus treats it as available (matches
      // Onboarding.tsx and listen.ts). On macOS the row follows the diagnosis and the loopback self-test.
      if (live) screenSetup.setPerms(perms)
      const screenRow = screenRowStatus(perms, screenSetup.checkRef.current, isWindows)
      set('screen', screenRow.state, screenRow.detail)
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
      const current = settingsRef.current
      const local =
        models.find((m) => m.id === current?.localLlm.modelId)
      // Observe only. Boot and an explicit Local AI opt-in own provisioning; setup must never start
      // optional multi-GB downloads while local AI is off or retry errors on every poll.
      const lm = current ? localModelRowStatus(local, current.localLlm.enabled,
        !current.allowedProviders || current.allowedProviders.includes('local')) : { state: 'checking' as const, detail: '' }
      set('local', lm.state, lm.detail, lm.progress)
    })()
    return () => {
      live = false
    }
  }, [scene, speechPackBlocked, speechPackManaged])

  // --- Live-poll while the scene stays mounted, so a grant flipped in System Settings (possibly in a
  // split view right next to this window) is reflected without the user coming back to click anything.
  useEffect(() => {
    if (scene !== 'setup') return
    let live = true
    const poll = async (): Promise<void> => {
      const perms = await window.toto.getPermissions().catch(() => null)
      const models = await window.toto.localModelsList().catch(() => [])
      const asrStatusNow = speechPackBlocked ? null : await window.toto.asrAssetsStatus().catch(() => null)
      if (!live) return
      if (asrStatusNow) setAsrStatus(asrStatusNow)
      const current = settingsRef.current
      const local = models.find((m) => m.id === current?.localLlm.modelId)
      const lm = current ? localModelRowStatus(local, current.localLlm.enabled,
        !current.allowedProviders || current.allowedProviders.includes('local')) : { state: 'checking' as const, detail: '' }
      const asr = asrStatusNow ? asrAssetsRowStatus(asrStatusNow, current?.asrEngine) : null
      // The screen row re-derives from this snapshot; a fresh grant mid-scene reads needs-relaunch (macOS).
      if (perms) screenSetup.setPerms(perms)
      setRows((rs) =>
        rs.map((r) => {
          if (r.key === 'asr' && asr) {
            return { ...r, state: asr.state, detail: speechPackManaged ? `${asr.detail} Managed by your organization.` : asr.detail, progress: asr.progress }
          }
          if (r.key === 'local') return { ...r, state: lm.state, detail: lm.detail, progress: lm.progress }
          if (!perms) return r
          if (r.key === 'mic') {
            const mic = micRowStatus(perms.microphone)
            return { ...r, state: mic.state, detail: mic.detail }
          }
          return r
        })
      )
    }
    const interval = setInterval(() => void poll(), PERMISSIONS_POLL_MS)
    const unsub = window.toto.onImportAssetsProgress?.((d) => {
      if (!live) return
      const asr = asrAssetsRowStatus({ ...d, ready: d.status === 'ready' }, settingsRef.current?.asrEngine)
      setRows((rs) =>
        rs.map((r) => (r.key === 'asr' ? { ...r, state: asr.state, detail: asr.detail, progress: asr.progress } : r))
      )
    })
    return () => {
      live = false
      clearInterval(interval)
      unsub?.()
    }
  }, [scene, settings?.localLlm.modelId, speechPackBlocked, speechPackManaged])

  const retryAsr = async (): Promise<void> => {
    if (speechPackBlocked) return
    const status = await window.toto.asrAssetsEnsure().catch((err) => asrEnsureFailureStatus(err))
    setAsrStatus(status)
    const asr = asrAssetsRowStatus(status, settingsRef.current?.asrEngine)
    setRows((rs) => rs.map((r) => (r.key === 'asr' ? { ...r, state: asr.state, detail: asr.detail, progress: asr.progress } : r)))
  }

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
  // CTA, not personalize's Start (which now only advances to license/appearance, see sceneAfterPersonalize).
  // Returns a promise so ActReady can keep the durable save and window replacement in one retry-safe flow.
  const finish = async (destination: 'answer' | 'settings'): Promise<boolean> => {
    if (doneRef.current || !canMarkOnboardingDone({ scene, asrReady, consent })) return false
    doneRef.current = true
    try {
      lockOnboardingAudio()
      haltAllOnboardingAudio()
      music.stop()
      disposePortalAudio()
      await closeOnboardingPortal(music.muted, prefersReducedMotion())
      playBarLand(music.muted)
      requestBarLand()
      await onDone({ mode, recordingConsent: true, destination })
      return true
    } catch (error) {
      doneRef.current = false
      document.querySelector('.onboard-stage')?.classList.remove('onboard-stage--portal-close')
      // A rejected durable save must visibly reopen the same Ready screen. Removing close alone can
      // leave the portal mask at its collapsed rest state, which reads as a frozen final step.
      requestOnboardingPortalOpen()
      throw error
    }
  }

  const { scanDone, allReady } = summarizeSetupRows(rows)
  // 'blocked' counts here for the same reason 'action' does — it was one of those states before it got
  // its own name, and Continue must not go primary while the mic is still denied. The AI row is
  // deliberately excluded: transcription works without AI. A managed licence or personal provider
  // can be connected after setup, so AI never blocks Continue the way transcription assets do.
  const needsPerms = rows.some(
    (r) => (r.key === 'mic' || r.key === 'screen') && (r.state === 'action' || r.state === 'blocked' || r.state === 'restart')
  )
  const asrBlocksContinue = setupAsrBlocksContinue(rows, asrStatus, setupAccessFailOpen)

  return (
    <OnboardingExperienceLayout
      {...{
        scene,
        heroVideoRef,
        music,
        mode,
        setMode,
        setScene,
        rows,
        asrRow,
        asrReady,
        scanDone,
        allReady,
        needsPerms,
        asrBlocksContinue,
        consent,
        setConsent,
        settings,
        patch,
        screenSetup,
        restarting,
        retryAsr,
        requestMic,
        restartApp,
        playHero,
        appearance,
        appearanceLocked,
        placement,
        placementLocked,
        appearanceSave,
        pickAppearance,
        pickPlacement,
        finish,
        onOpenAiSettings,
        recoverEncryptedProfile,
        authReady
      }}
    />
  )
}

export function OnboardingV2({
  settings,
  recoverEncryptedProfile,
  patch,
  onOpenAiSettings,
  onDone,
  authReady
}: {
  settings: PublicSettings
  saveKey?: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile?: () => Promise<ProfileRecoveryResult>
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings>
  onOpenAiSettings?: () => void
  onDone: () => void
  authReady: boolean
}): JSX.Element {
  return (
    <OnboardingExperience
      settings={settings}
      patch={patch}
      recoverEncryptedProfile={recoverEncryptedProfile}
      onOpenAiSettings={onOpenAiSettings}
      authReady={authReady}
      onDone={async ({ mode, recordingConsent, destination }) => {
        lockOnboardingAudio()
        haltAllOnboardingAudio()
        await persistOnboardingCompletion({
          settingsPatch: { mode, recordingConsent, onboardingDone: true, onboardingDoneAt: Date.now() },
          patch,
          onCompleted: onDone
        })
        window.toto.onboardingExit(destination)
      }}
    />
  )
}
