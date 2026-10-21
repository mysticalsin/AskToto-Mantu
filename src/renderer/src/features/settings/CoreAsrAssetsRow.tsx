/**
 * CoreAsrAssetsRow.tsx — Settings' status and recovery row for the required transcription assets (Parakeet and
 * the Whisper floor), moved out of AiSection.tsx unchanged so that file stays within its size budget.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react'
import type { AsrAssetsStatus } from '@shared/ipc'
import {
  bundleFailureUserMessage,
  isRepairRequiredBundleMessage,
  isRetryableBundleMessage
} from '@shared/bundle-response'
import { InlineOrb } from '../../components/AgentStatus'
import { TextButton } from '../../components/ui'

/** Public release page used only when a signed package reports damaged built-in transcription assets. */
export const OFFICIAL_METIS_INSTALLER_URL = 'https://github.com/mysticalsin/Metis-Releases/releases/latest'

export type CoreAsrAssetsView = {
  state: 'checking' | 'ready' | 'downloading' | 'retry' | 'repair' | 'error'
  detail: string
  progress?: number
}

/** Settings must never remain on “Checking” when an IPC renderer round-trip is lost. */
export const CORE_ASR_STATUS_TIMEOUT_MS = 5_000

/**
 * Core Parakeet + Whisper-floor assets are distinct from the optional import-only Whisper model.
 * This derives the only honest recovery action for the immutable packaged payload versus a retryable
 * development/download failure.
 */
export function coreAsrAssetsView(status: AsrAssetsStatus | null | undefined): CoreAsrAssetsView {
  if (!status) return { state: 'checking', detail: 'Checking transcription files…' }
  if (status.ready || status.status === 'ready') return { state: 'ready', detail: 'Transcription files ready.' }

  const detail = bundleFailureUserMessage(status.error || status.label)
  if (isRepairRequiredBundleMessage(detail)) return { state: 'repair', detail }
  if (status.status === 'downloading') {
    return { state: 'downloading', detail: status.label || 'Getting transcription files…', progress: status.progress }
  }
  if (status.status === 'idle') {
    return {
      state: 'retry',
      detail: 'Transcription files are not ready. Select Try again to finish setup on this device.'
    }
  }
  if (status.status === 'error' && isRetryableBundleMessage(detail)) return { state: 'retry', detail }
  return { state: 'error', detail: detail || 'Métis could not read transcription-file status. Check again.' }
}

export function coreAsrAssetsFailureStatus(error: unknown): AsrAssetsStatus {
  const message = bundleFailureUserMessage(error)
  return { ready: false, status: 'error', progress: 0, label: message, error: message }
}

/** Bound an IPC status read so Settings always reaches an actionable state. */
export async function readCoreAsrAssetsStatus(
  read: () => Promise<AsrAssetsStatus>,
  timeoutMs = CORE_ASR_STATUS_TIMEOUT_MS
): Promise<AsrAssetsStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<AsrAssetsStatus>((resolve) => {
        timer = setTimeout(
          () => resolve(coreAsrAssetsFailureStatus(new Error('Transcription-file status timeout. Try again.'))),
          timeoutMs
        )
      })
    ])
  } catch (error) {
    return coreAsrAssetsFailureStatus(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Kept separate for a focused retry test and so the UI never swallows a failed ensure into a spinner. */
export async function retryCoreAsrAssets(ensure: () => Promise<AsrAssetsStatus>): Promise<AsrAssetsStatus> {
  try {
    return await ensure()
  } catch (error) {
    return coreAsrAssetsFailureStatus(error)
  }
}

/**
 * Settings-side recovery route for the required transcription assets. The onboarding view can safely
 * finish while these are deferred only because this route remains available afterwards.
 */
export function CoreAsrAssetsRow({ initialStatus }: { initialStatus?: AsrAssetsStatus | null } = {}): JSX.Element {
  const [status, setStatus] = useState<AsrAssetsStatus | null>(initialStatus ?? null)
  const [retrying, setRetrying] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const next = await readCoreAsrAssetsStatus(() => window.toto.asrAssetsStatus())
    if (live.current) setStatus(next)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A transfer may have begun during onboarding before Settings opened. Observe its progress here as
  // well, and poll only while active so a dropped event cannot leave a static percentage behind.
  useEffect(() => {
    if (status?.status !== 'downloading') return
    const unsubscribe = window.toto.onImportAssetsProgress?.((progress) => {
      if (live.current) setStatus({ ...progress, ready: progress.status === 'ready' })
    })
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => {
      unsubscribe?.()
      window.clearInterval(timer)
    }
  }, [refresh, status?.status])

  const retry = (): void => {
    if (retrying) return
    setRetrying(true)
    void retryCoreAsrAssets(window.toto.asrAssetsEnsure)
      .then((next) => {
        if (live.current) setStatus(next)
      })
      .finally(() => {
        if (live.current) setRetrying(false)
      })
  }

  const view = coreAsrAssetsView(status)
  const percent = Math.round(Math.max(0, Math.min(1, view.progress ?? 0)) * 100)

  return (
    <div className="flex flex-col gap-1.5 px-1 py-1" aria-live="polite">
      <div className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
        <span>Transcription files</span>
        {view.state === 'ready' && <Check size={13} className="text-[var(--cl-primary)]" aria-label="Ready" />}
        {view.state === 'checking' || view.state === 'downloading' ? <InlineOrb kind="loading" /> : null}
      </div>
      <p className="m-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{view.detail}</p>
      {view.state === 'downloading' && (
        <div
          role="progressbar"
          aria-label="Transcription file download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--cl-border)]"
        >
          <div
            className="h-full rounded-full bg-[color:var(--cl-primary)] transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {view.state === 'retry' && (
        <TextButton icon={RotateCcw} onClick={retry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Try again'}
        </TextButton>
      )}
      {view.state === 'error' && (
        <TextButton icon={RefreshCw} onClick={() => void refresh()}>
          Check again
        </TextButton>
      )}
      {view.state === 'repair' && (
        <a
          href={OFFICIAL_METIS_INSTALLER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="no-drag focus-ring inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
        >
          <ExternalLink size={11} />
          Open official installer
        </a>
      )}
    </div>
  )
}
