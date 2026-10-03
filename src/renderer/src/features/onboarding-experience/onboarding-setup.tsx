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

export type SetupRowState = 'checking' | 'loading' | 'ready' | 'action' | 'blocked' | 'restart' | 'skipped'

export interface SetupRow {
  key: string
  label: string
  icon: typeof Sparkles
  state: SetupRowState
  detail?: string
  progress?: number
}

export function setupRowsForSpeechPackPolicy(policy: LocalSpeechPackSetting): SetupRow[] {
  return [
    ...(speechPackSetupRowVisible(policy) ? [{ key: 'asr', label: 'On-device transcription', icon: Sparkles, state: 'checking' } satisfies SetupRow] : []),
    { key: 'brain', label: 'Private meeting brain', icon: FolderLock, state: 'checking' },
    { key: 'mic', label: 'Microphone', icon: Mic, state: 'checking' },
    { key: 'screen', label: MEETING_AUDIO_SCREEN_LABEL, icon: MonitorUp, state: 'checking' },
    { key: 'ai', label: 'Métis AI', icon: Cloud, state: 'checking' },
    { key: 'local', label: 'On-device model', icon: Cpu, state: 'checking' }
  ]
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
 *  cannot back up. Cloudflare may be supplied by a verified managed licence or a user's own endpoint;
 *  readiness alone does not establish which credential path was used. No shared key is embedded in
 *  generic releases. A non-Cloudflare provider also reads as ready only when main confirms it.
 *  Never gates onboarding's Continue — adding a personal key stays optional, exactly as it is once
 *  onboarding finishes (Settings → AI). */
export function aiRowStatus(
  settings: Pick<PublicSettings, 'providerReady' | 'provider'> | null | undefined
): { state: SetupRowState; detail: string } {
  if (!settings) return { state: 'checking', detail: '' }
  if (settings.providerReady) {
    return settings.provider === 'cloudflare'
      ? { state: 'ready', detail: 'Ready: Cloudflare AI connected' }
      : { state: 'ready', detail: `Ready: ${PROVIDERS[settings.provider].label} configured` }
  }
  return { state: 'action', detail: 'not configured yet' }
}

/** Optional local AI is distinct from the required on-device transcription assets. */
export function localModelRowStatus(
  model:
    | Pick<LocalModelSummary, 'ready' | 'unavailableReason' | 'downloadProgress' | 'minTotalRamGB'>
    | null
    | undefined,
  enabled = true,
  allowed = true
): { state: SetupRowState; detail: string; progress?: number } {
  if (!allowed) return { state: 'skipped', detail: 'Optional local AI is restricted by your organization.' }
  if (!enabled) return { state: 'skipped', detail: 'Optional local AI is off. Enable it in Settings when you need it.' }
  if (!model) return { state: 'checking', detail: '' }
  if (model.unavailableReason === 'insufficient-ram') {
    return {
      state: 'blocked',
      detail: `This device needs at least ${model.minTotalRamGB} GB of memory for the on-device model.`
    }
  }
  if (model.unavailableReason === 'insufficient-disk') {
    return {
      state: 'action',
      detail: 'Not enough free disk space for the on-device model.'
    }
  }
  if (model.unavailableReason === 'downloading') {
    const p = model.downloadProgress
    const real = p != null && p > 0 && p < 1
    return {
      state: 'loading',
      detail: real ? `Downloading ${Math.round(p * 100)}%` : 'Downloading…',
      progress: p
    }
  }
  if (model.unavailableReason === 'download-failed') {
    return { state: 'action', detail: 'Download failed. Check your connection and select Retry.' }
  }
  if (model.unavailableReason === 'not-downloaded') {
    return { state: 'action', detail: 'Not downloaded yet. Select Retry to download the on-device model.' }
  }
  if (model.ready) return { state: 'ready', detail: 'On-device model ready' }
  return { state: 'checking', detail: 'Checking the on-device model…' }
}

export const IDLE_ASR_STATUS: AsrAssetsStatus = {
  ready: false,
  status: 'idle',
  progress: 0,
  label: 'Getting transcription files…'
}

/** Act 3 transcription row. Never skip a missing bundle. Immutable package failures explain how to recover. */
export function asrAssetsRowStatus(
  input: AsrAssetsStatus | null | undefined,
  engine?: PublicSettings['asrEngine']
): { state: SetupRowState; detail: string; progress?: number } {
  const s = input ?? IDLE_ASR_STATUS
  if (s.ready || s.status === 'ready') {
    const selected = engine === 'parakeet' ? 'Parakeet' : engine === 'whisper' ? 'Whisper base' : engine === 'apple' ? 'Apple Speech' : null
    return {
      state: 'ready',
      detail: `Parakeet + Whisper base files ready.${selected ? ` Selected for live meetings: ${selected}.` : ''}`
    }
  }
  if (s.status === 'error') {
    return {
      state: 'action',
      detail: s.error || s.label || 'Could not get the transcription files. Try again.'
    }
  }
  if (s.status === 'downloading' || s.status === 'idle') {
    return {
      state: 'loading',
      detail: s.label || 'Getting transcription files…',
      progress: s.progress
    }
  }
  return { state: 'loading', detail: s.label || 'Getting transcription files…', progress: s.progress }
}

/** AgentStatus percent is 0–100. Only a real open interval (0, 1) becomes a determinate %. */
export function setupRowLoadingPercent(progress: number | null | undefined): number | undefined {
  if (progress == null || !Number.isFinite(progress)) return undefined
  if (progress <= 0 || progress >= 1) return undefined
  return Math.round(progress * 100)
}

export function asrRowNeedsRetry(row: Pick<SetupRow, 'state' | 'detail'>): boolean {
  if (row.state !== 'action') return false
  return isRetryableBundleMessage(row.detail)
}

/** A packaged app cannot alter a signed resource bundle. Let the user re-check after installing a repaired build. */
export function asrRowNeedsRepair(row: Pick<SetupRow, 'state' | 'detail'>): boolean {
  return row.state === 'action' && isRepairRequiredBundleMessage(row.detail)
}

/** Ensure / status IPC failure. Never idle. Always Retry. */
export function asrEnsureFailureStatus(err?: unknown): AsrAssetsStatus {
  const message = bundleFailureUserMessage(err)
  return { ready: false, status: 'error', progress: 0, label: message, error: message }
}

/**
 * First-run prefers ready transcription files, but must never spin forever.
 * After ASR_SETUP_FAIL_OPEN_MS (or an ensure error), Continue unlocks; Retry
 * stays on the row. Access/OS prompts must not gate this CTA.
 */
export const ASR_SETUP_FAIL_OPEN_MS = 2_000
/** @deprecated alias — prefer ASR_SETUP_FAIL_OPEN_MS */
export const ASR_SETUP_RETRY_TIMEOUT_MS = ASR_SETUP_FAIL_OPEN_MS

export function setupAsrBlocksContinue(
  rows: SetupRow[],
  asrStatus?: AsrAssetsStatus | null,
  failOpen = false
): boolean {
  // Latched fail-open: poll/ensure must never re-mute Continue after the timer.
  if (failOpen) return false
  if (summarizeSetupRows(rows).allReady) return false
  if (asrStatusIsReady(asrStatus)) return false
  // Fail-open: error unlocks Continue (Retry stays on the row).
  if (asrStatus?.status === 'error') return false
  const asr = rows.find((r) => r.key === 'asr')
  if (asr && (asr.state === 'ready' || asr.state === 'skipped')) return false
  if (!asr) return rows.length === 0
  return true
}

/** First-run may finish from Ready once consent is given; transcription recovery remains available in Settings. */
export function firstRunCanFinish(input: { asrReady: boolean; consent: boolean }): boolean {
  return input.consent
}

/** An enabled setup CTA must not look disabled just because permissions need attention. */
export function setupContinueLabel(needsPermissions: boolean): string {
  return needsPermissions ? 'Continue anyway' : 'Continue'
}

export function asrStatusIsReady(status: AsrAssetsStatus | null | undefined): boolean {
  return Boolean(status?.ready || status?.status === 'ready')
}

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
export function MiniToggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
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
export function licenseErrorMessage(code: string | undefined): string {
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
    case 'insecure_url':
      return 'Use an HTTPS license server address. Only localhost can use HTTP for testing.'
    case 'device_identity_unavailable':
      return 'Métis cannot save its device setup. Close other Métis copies, check that its data folder is writable, and try again. If it persists, contact support to repair the data folder.'
    default:
      return code || 'Could not activate this license.'
  }
}

