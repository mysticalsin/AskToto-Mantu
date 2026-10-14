import { useEffect, useState } from 'react'
import type {
  SpeechPackActionRequest,
  SpeechPackActionResult,
  SpeechPackComponentSnapshot,
  SpeechPackProgress,
  SpeechPackSnapshot
} from '@shared/speech-pack'

type ComponentId = SpeechPackComponentSnapshot['componentId']
type PackState = SpeechPackComponentSnapshot['state']
type PackProgress = SpeechPackProgress
type PackSnapshot = SpeechPackSnapshot
type Action = SpeechPackActionRequest['action']
export type SpeechPackBridge = {
  speechPackState: () => Promise<PackSnapshot>
  speechPackAction: (request: SpeechPackActionRequest) => Promise<SpeechPackActionResult>
  onSpeechPackProgress: (callback: (progress: PackProgress) => void) => () => void
}

function sizeLabel(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.ceil(bytes / (1024 * 1024))} MB`
}

function labelFor(state: PackState): string {
  switch (state) {
    case 'not-installed':
      return 'Not downloaded'
    case 'repair-needed':
      return 'Needs repair'
    case 'not-configured':
      return 'Download unavailable'
    case 'queued':
      return 'Starting'
    case 'downloading':
      return 'Downloading'
    case 'verifying':
      return 'Checking files'
    case 'self-testing':
      return 'Testing on this device'
    case 'ready':
      return 'Ready'
    case 'paused':
      return 'Paused'
    case 'error':
      return 'Could not finish'
  }
}

export function SpeechPackSection({
  bridge,
  selectedEngine
}: {
  bridge: SpeechPackBridge
  selectedEngine: 'whisper' | 'parakeet' | 'apple' | string
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<PackSnapshot | null>(null)
  const [progress, setProgress] = useState<PackProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    void bridge
      .speechPackState()
      .then((value) => {
        if (current) {
          setSnapshot(value)
          setProgress(value.progress)
        }
      })
      .catch(() => {
        if (current) setMessage('Speech-pack status is unavailable right now.')
      })
    const unsubscribe = bridge.onSpeechPackProgress((value) => {
      if (current) setProgress(value)
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [bridge, selectedEngine])

  const selected = snapshot?.selectedComponent
  const row = snapshot?.components.find((component) => component.componentId === selected)
  const live = progress?.componentId === selected ? progress : null
  const state = live?.state ?? row?.state ?? 'not-installed'
  const active = state === 'queued' || state === 'downloading' || state === 'verifying' || state === 'self-testing'
  const run = async (action: Action): Promise<void> => {
    if (!row) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await bridge.speechPackAction({
        componentId: row.componentId,
        action,
        manifestIdentity: row.manifestIdentity
      })
      if (!result.ok)
        setMessage(
          result.reason === 'policy-blocked'
            ? 'Downloads are disabled by your organization.'
            : 'This action is not available right now.'
        )
      else if (action === 'download' || action === 'retry' || action === 'repair')
        setProgress({
          componentId: row.componentId,
          manifestIdentity: row.manifestIdentity,
          bytesDone: 0,
          bytesTotal: row.downloadBytes,
          state: 'queued'
        })
    } catch {
      setMessage('Could not update this speech pack.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--cl-border)] bg-white/[0.02] p-3">
      <h3 className="text-[13px] font-medium text-[color:var(--cl-foreground)]">On-device speech model</h3>
      <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Download is optional and starts only when you choose it. Métis checks the files and tests the model on this
        device before using it.
      </p>
      {!snapshot ? (
        <p className="mt-2 text-[11px]">Loading model status…</p>
      ) : snapshot.profileError ? (
        <p role="alert" className="mt-2 text-[11px] text-amber-300">
          Speech-pack settings need repair. Reinstall the official Métis package.
        </p>
      ) : !row ? (
        <p className="mt-2 text-[11px]">Apple on-device speech is selected; it does not use an optional model pack.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span>
              {snapshot.selectedEngine === 'whisper' ? 'Whisper base' : 'Parakeet'} · {labelFor(state)}
            </span>
            <span>{sizeLabel(row.downloadBytes)}</span>
          </div>
          {state === 'not-configured' && (
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">
              A trusted download source is not configured for this pack yet.
            </p>
          )}
          {live?.state === 'downloading' && (
            <progress
              className="w-full"
              max={Math.max(live.bytesTotal, 1)}
              value={Math.min(live.bytesDone, live.bytesTotal)}
              aria-label="Speech model download progress"
            />
          )}
          {row.integrity === 'prior-activation-and-size-checked' && state === 'ready' && (
            <p className="text-[10px] text-[color:var(--cl-muted-foreground)]">
              Previously verified files are present. Full verification runs before use after a repair.
            </p>
          )}
          {row.integrity === 'freshly-hash-verified-and-self-tested' && state === 'ready' && (
            <p className="text-[10px] text-[color:var(--cl-muted-foreground)]">Files and model test passed.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {!active && state !== 'ready' && state !== 'not-configured' && (
              <button
                type="button"
                disabled={busy || !snapshot.featureEnabled}
                onClick={() => void run(state === 'error' || state === 'paused' ? 'retry' : 'download')}
                className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
              >
                {state === 'error' || state === 'paused' ? 'Retry' : 'Download'}
              </button>
            )}
            {active && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('pause')}
                className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
              >
                Pause
              </button>
            )}
            {(active || state === 'paused') && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('cancel')}
                className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            {state === 'ready' && (
              <button
                type="button"
                disabled={busy || !snapshot.featureEnabled}
                onClick={() => void run('repair')}
                className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
              >
                Repair
              </button>
            )}
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="mt-2 text-[11px] text-amber-300">
          {message}
        </p>
      )}
    </section>
  )
}
