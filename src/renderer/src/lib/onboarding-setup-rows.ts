import {
  bundleFailureUserMessage,
  isRepairRequiredBundleMessage,
  isRetryableBundleMessage
} from '@shared/bundle-response'
import { Cloud, Cpu, FolderLock, Mic, MonitorUp, Sparkles } from 'lucide-react'
import type { AsrAssetsStatus, PermissionStatus, PublicSettings } from '@shared/ipc'
import { MEETING_AUDIO_SCREEN_LABEL } from './screen-permission-copy'
import { speechPackSetupRowVisible, type LocalSpeechPackSetting } from './local-speech-pack-policy'

/** Act 3 setup-scan rows: pure status mapping shared by the onboarding setup scene and its tests. */
// 'restart' = permission is actually granted, but this same-session ScreenCaptureKit handle never saw it
// (macOS only applies a fresh Screen Recording grant to the NEXT launch) — needs a relaunch, not a prompt.
// 'blocked' = the OS holds an explicit Deny, which no prompt can undo — only the privacy pane can.
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
    ...(speechPackSetupRowVisible(policy)
      ? [{ key: 'asr', label: 'On-device transcription', icon: Sparkles, state: 'checking' } satisfies SetupRow]
      : []),
    { key: 'brain', label: 'Private meeting brain', icon: FolderLock, state: 'checking' },
    { key: 'mic', label: 'Microphone', icon: Mic, state: 'checking' },
    { key: 'screen', label: MEETING_AUDIO_SCREEN_LABEL, icon: MonitorUp, state: 'checking' },
    { key: 'ai', label: 'Métis AI', icon: Cloud, state: 'checking' },
    { key: 'local', label: 'On-device model', icon: Cpu, state: 'checking' }
  ]
}

/** The microphone row for an OS permission status. 'denied' MUST be its own state: getUserMedia never
 *  re-prompts after an explicit Deny and main's requestPermissionsUpfront only asks while the status is
 *  'not-determined', so in that state the row's "Continue" would produce no prompt, no error and no
 *  change — the OS privacy pane is the only way back, exactly as the screen row already offers. */
export function micRowStatus(status: PermissionStatus | undefined): { state: SetupRowState; detail: string } {
  if (status === 'granted') return { state: 'ready', detail: 'granted' }
  if (status === 'denied') return { state: 'blocked', detail: 'permission denied' }
  return { state: 'action', detail: 'needs permission' }
}

export const IDLE_ASR_STATUS: AsrAssetsStatus = {
  ready: false,
  status: 'idle',
  progress: 0,
  label: 'Getting transcription files…'
}

/** The setup scan waited ASR_SETUP_FAIL_OPEN_MS and the files are still arriving. This is a slow download,
 *  not a failure: it stays non-terminal so the live poll keeps updating the percentage. */
export function asrStatusWhileStillDownloading(prev?: AsrAssetsStatus | null): AsrAssetsStatus {
  return {
    ready: false,
    status: 'downloading',
    progress: prev?.progress || 0,
    label: 'Transcription files are still downloading. You can continue and finish them in Settings.'
  }
}

/** Act 3 transcription row. Never skip a missing bundle. Immutable package failures explain how to recover. */
export function asrAssetsRowStatus(
  input: AsrAssetsStatus | null | undefined,
  engine?: PublicSettings['asrEngine']
): { state: SetupRowState; detail: string; progress?: number } {
  const s = input ?? IDLE_ASR_STATUS
  if (s.ready || s.status === 'ready') {
    const selected =
      engine === 'parakeet'
        ? 'Parakeet'
        : engine === 'whisper'
          ? 'Whisper base'
          : engine === 'apple'
            ? 'Apple Speech'
            : null
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
