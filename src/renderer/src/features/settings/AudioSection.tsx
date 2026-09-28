import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import appPackage from '../../../../../package.json'
import type { NavigationGuardService } from '../../lib/navigation-guard'
import { TapControlCard } from '../../components/TapCalibration'
import {
  Check,
  ExternalLink,
  Mic,
  Volume2,
  Headphones,
  ChevronDown,
  ChevronUp,
  Sparkles,
  FolderOpen,
  FolderCog,
  AlertCircle,
  Trash2,
  Cpu,
  Wand2,
  ShieldCheck,
  Info,
  IdCard,
  X,
  Search,
  RefreshCw,
  Link2,
  CircleCheck,
  FileText,
  Upload,
  RotateCcw,
  Trash,
  Network,
  Calendar,
  Bell,
  User,
  MoreHorizontal,
  Plus,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  MessageSquare,
  MessageSquareQuote,
  Lightbulb,
  AlignLeft,
  FileSearch,
  Camera,
  Eye,
  Settings2,
  Lock,
  Timer,
  ListTree,
  Route,
  type LucideIcon
} from 'lucide-react'
import { timeSavedFromTotals } from '@shared/time-saved'
import { TimeSavedView } from '../../components/TimeSavedView'
import { autoHideOverlayForLayout } from '@shared/overlay-chrome'
import { overlayShowsBarRestPicker } from '@shared/overlay-orb'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'
import { OverlayChromePicker } from '../../components/OverlayChromePicker'
import { OverlayPlacementPicker } from '../../components/OverlayPlacementPicker'
import { OverlayOrbPicker } from '../../components/OverlayOrbPicker'
import { persistOverlayPlacement } from '../../lib/overlay-placement-save'
import { formatResetPhrase } from '@shared/reset-time'
import {
  DEFAULT_SHORTCUTS,
  HOTKEY_ACTIONS,
  BUILTIN_MODE_LABELS,
  MODE_GROUPS,
  modeLabel,
  type PublicSettings,
  type AsrAssetsStatus,
  type Profile,
  type TestKeyResponse,
  type ProfileRecoveryResult,
  type DustAgent,
  DUST_BASE_AGENT_ID,
  type ConversationMode,
  type BuiltinMode,
  type CustomMode,
  type AuthStatus,
  type GraphStatus,
  type HotkeyAction,
  type EvalMetrics,
  type MeetingSummary,
  type ShortcutFailure,
  type LocalModelSummary,
  type PlatformPermissions,
  type UpdateCheckResult,
  type McpConnectionKind,
  type LicenseStatusResult,
  type ScreenCaptureCheckResult,
  type PreservedBrainIndexCopy
} from '@shared/ipc'
import { nextScreenCheckPass } from '@shared/screen-capture-check'
import { bundleFailureUserMessage, isRepairRequiredBundleMessage, isRetryableBundleMessage } from '@shared/bundle-response'
import {
  PROVIDERS,
  PROVIDER_IDS,
  requiresUserBaseUrl,
  detectProvider,
  parseDustUrl,
  resolveModelTier,
  applyInteractiveGuardrail,
  isDustReady,
  dustStoredAgentMissing,
  type ProviderId
} from '@shared/providers'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { modeSkillLock } from '@shared/mode-skills'
import { DEFAULT_OPERATOR_URL, operatorUrlConfigured } from '@shared/operator'
import { LANGUAGE_OPTIONS } from '@shared/lang-id'
import { isCloudOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { effectiveCloudSttProvider, type CloudSttProviderId } from '@shared/cloud-stt-provider'
import { MantuLogo } from '../../components/MantuLogo'
import { MantuMark } from '../../components/MantuMark'
import { ClickUpMark } from '../../components/brand/ClickUpMark'
import { PlaneMark } from '../../components/brand/PlaneMark'
import { MetisMark } from '../../components/MetisMark'
import { IdentitySection } from '../../components/IdentitySection'
import { FieldHint, TextButton } from '../../components/ui'
import { shouldUseBundledAsr } from '../../lib/asr-offline'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { AgendaView } from '../../components/AgendaView'
import { usePermissions } from '../../state'
import { displayAccelerator, isWindows } from '../../lib/keys'
import { decideDustLiveCheck } from '../../lib/dust-live-check'
import { haltAllOnboardingAudio, unlockOnboardingAudio } from '../../lib/onboarding-music'
import { canShowConnected, cliSetupChip, nextCliSetupStep } from '@shared/cli-setup-status'
import {
  DUST_EMPTY_AGENTS_ERROR,
  DUST_WORKSPACE_MISSING_SETUP_ERROR,
  decideDustInstantValidate,
  formatDustConnectedMessage,
  proveDustConnection,
  type DustInstantValidateResult
} from '@shared/dust-validate'
import {
  SETTINGS_CONTENT_SCROLL_CLASS,
  Section,
  TabIconContext,
  ToggleRow,
  ctl,
  managedChipCls,
  settingsScrollClipsOverflowX
} from '../../ui/settings'
import { CLI_PROVIDERS, DUST_CREDENTIAL_STORE, PROFILE_CREDENTIAL_STORE, LICENSE_UI_ENABLED, LazyInput, LazyTextarea, VocabCorrectionsTextarea, ManagedChip, ProviderTile, ExpandableSection, VocabSuggestions, detectHint, isProfileUnlockError, SonioxKeySeat, pickReadyProvider, recommendedProvider, prettyModel, type SettingsWithAsrWebgpuFallback } from './SettingsSupport'
import { getAudioChoices } from './DustSetup'
export function AudioChoices({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-3 gap-2">
      {getAudioChoices().map((c) => {
        const active = c.id === settings.audioSource
        const locked = settings.managedKeys.includes('audioSource')
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={active}
            disabled={locked}
            onClick={() => patch({ audioSource: c.id })}
            className={[
              'no-drag cl-focus flex min-w-0 w-full flex-col items-center gap-1 rounded-[var(--cl-radius)] border px-2 py-3 text-center transition-colors',
              active
                ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
                : 'border-[var(--cl-border)] bg-white/[0.02] hover:bg-white/[0.05]',
              locked ? 'opacity-60 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <c.icon size={16} className={active ? 'text-[color:var(--cl-primary)]' : 'text-[color:var(--cl-muted-foreground)]'} />
            <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{c.label}</span>
            <span className="min-w-0 break-words text-[11px] text-[color:var(--cl-muted-foreground)]">{c.desc}</span>
            <span className="min-w-0 break-words text-[10px] text-[color:var(--cl-muted-foreground)]">{c.perm}</span>
          </button>
        )
      })}
    </div>
  )
}

// Full-scale RMS for the level meter below. Well above the VAD's own "is speaking" threshold
// (lib/vad.ts ON = 0.012) so normal close-mic speech visibly moves the bar without pegging it on
// every breath; this is a "do I have signal" indicator, not a calibrated VU meter.
export const MIC_METER_FULL_SCALE = 0.2

/** Live input-level meter for MicPicker: opens its own getUserMedia + AnalyserNode against whichever
 *  device is selected (or the system default) so a user can confirm a mic — especially a newly paired
 *  Bluetooth/iPhone mic — is actually delivering signal before a meeting, without starting a real
 *  capture. Entirely separate from the app's real capture pipeline (lib/listen.ts); it never touches
 *  settings or recording state, only visualizes.
 *
 *  RMS math mirrors lib/vad.ts / whisper-worklet-src.ts (sum of squares over the buffer, then sqrt) so
 *  the bar reflects the same "how loud is this" signal the transcription pipeline itself computes.
 *
 *  Cleanup is the load-bearing part: a leaked getUserMedia stream keeps the mic hot and the OS
 *  recording indicator lit. teardown() stops every track, closes the AudioContext, and cancels the
 *  rAF loop; the effect calls it on every unmount AND every deviceId change (effect cleanup runs
 *  before the next effect body), so switching devices or leaving the Audio tab (this component
 *  unmounts with it — see the `tab === 'audio'` guard around MicPicker) always fully releases the mic. */
export function MicLevelMeter({
  deviceId,
  permissionNonce
}: {
  deviceId: string
  /** Bumped by MicPicker's unlockLabels() after a fresh mic-permission grant. deviceId alone doesn't
   *  change when permission is granted in the same panel, so the meter would otherwise stay stuck on
   *  "No signal" until some unrelated device switch re-ran this effect. */
  permissionNonce?: number
}): JSX.Element {
  // null = not blocked. Otherwise the getUserMedia failure kind, so the hint below can name the actual
  // cause instead of always saying "allow microphone access" (wrong for a disconnected/OverconstrainedError device).
  const [blockedReason, setBlockedReason] = useState<'permission' | 'device' | 'other' | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0

    const teardown = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      if (ctx && ctx.state !== 'closed') void ctx.close()
      ctx = null
    }

    void (async (): Promise<void> => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop()) // effect already torn down (unmount/device switch) mid-await
          return
        }
        stream = s
        const audioCtx = new AudioContext()
        ctx = audioCtx
        void audioCtx.resume() // some autoplay policies create it suspended; harmless no-op if already running
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        // A node graph that never reaches the destination is never pulled by the renderer, so the
        // analyser would silently stop updating — route it through a GAIN-0 node into destination to
        // keep it live without ever making the mic audible (no feedback through speakers).
        const mute = audioCtx.createGain()
        mute.gain.value = 0
        audioCtx.createMediaStreamSource(s).connect(analyser).connect(mute).connect(audioCtx.destination)
        const data = new Float32Array(analyser.fftSize)
        setBlockedReason(null)

        const tick = (): void => {
          analyser.getFloatTimeDomainData(data)
          let sumSquares = 0
          for (let i = 0; i < data.length; i++) {
            const v = data[i]
            sumSquares += v * v
          }
          const rms = Math.sqrt(sumSquares / data.length)
          const level = Math.min(1, rms / MIC_METER_FULL_SCALE)
          if (barRef.current) {
            barRef.current.style.width = `${level * 100}%`
            barRef.current.style.opacity = String(0.35 + level * 0.65)
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      } catch (e) {
        // Never throw, just show the hint below instead of the bar — but branch the copy on the actual
        // cause: permission denied vs. a device that vanished (OverconstrainedError from the
        // {deviceId:{exact}} constraint above, or NotFoundError) vs. anything else.
        if (cancelled) return
        const name = e instanceof Error ? e.name : ''
        if (name === 'NotAllowedError') setBlockedReason('permission')
        else if (name === 'OverconstrainedError' || name === 'NotFoundError') setBlockedReason('device')
        else setBlockedReason('other')
      }
    })()

    return () => {
      cancelled = true
      teardown()
    }
  }, [deviceId, permissionNonce])

  if (blockedReason) {
    const hint =
      blockedReason === 'permission'
        ? 'No signal. Allow microphone access to test this device.'
        : blockedReason === 'device'
          ? 'Device unavailable, choose another mic, or reconnect it and retry.'
          : 'No signal from this microphone.'
    return (
      <FieldHint text={hint}>
        <span className="flex h-2 w-16 shrink-0 items-center justify-center text-[color:var(--cl-muted-foreground)]">
          <AlertCircle size={12} />
        </span>
      </FieldHint>
    )
  }

  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-white/10"
    >
      <div
        ref={barRef}
        className="h-full w-0 rounded-full bg-[var(--cl-primary)] opacity-40 transition-[width,opacity] duration-75 ease-out"
      />
    </div>
  )
}

/** Microphone chooser: system default plus any input device (built-in, AirPods, iPhone, a headset).
 *  Device labels are blank until mic permission is granted once, so we offer a one-click reveal. The
 *  actual capture (lib/listen.ts) falls back to the default if the chosen device has disconnected. */
export function MicPicker({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [needsPerm, setNeedsPerm] = useState(false)
  // Bumped whenever unlockLabels() lands a fresh permission grant — passed to MicLevelMeter so it
  // re-acquires the stream instead of staying stuck on "No signal" (deviceId alone doesn't change here).
  const [permNonce, setPermNonce] = useState(0)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      setNeedsPerm(mics.length > 0 && mics.every((d) => !d.label)) // labels blank until permission granted
      setDevices(mics)
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  const unlockLabels = useCallback(async (): Promise<void> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop()) // just needed the grant so labels populate
      await refresh()
      setPermNonce((n) => n + 1)
    } catch {
      /* denied — leave the generic names in place */
    }
  }, [refresh])

  const locked = settings.managedKeys.includes('micDeviceId')
  return (
    <div className="mt-3 flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[12px] text-[color:var(--cl-muted-foreground)]">Microphone</span>
        <select
          value={settings.micDeviceId}
          disabled={locked}
          onChange={(e) => patch({ micDeviceId: e.target.value })}
          aria-label="Microphone"
          className={'no-drag min-w-0 flex-1 ' + ctl + (locked ? ' opacity-60' : '')}
        >
          <option value="">System default</option>
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
        <MicLevelMeter deviceId={settings.micDeviceId} permissionNonce={permNonce} />
      </div>
      {needsPerm ? (
        <button
          type="button"
          onClick={() => void unlockLabels()}
          className="no-drag w-fit text-[11px] text-[color:var(--cl-primary)] hover:underline"
        >
          Show device names
        </button>
      ) : (
        <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          Choose a specific mic, or keep the system default. If a chosen device disconnects, Métis falls
          back to the default so a meeting never loses its mic.
        </span>
      )}
    </div>
  )
}


/** Settings → About → Diagnostics. Nothing in this app uploads anywhere (zero telemetry, crash upload
 *  off), so when support needs the log trail the user exports it themselves: main + audit logs, crash
 *  dumps and the boot sentinel into a folder they choose — never meetings, the brain, or settings. */
