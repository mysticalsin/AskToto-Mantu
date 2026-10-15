import { useEffect, useRef, useState } from 'react'
import type {
  SpeechPackActionRequest,
  SpeechPackActionResult,
  SpeechPackComponentSnapshot,
  SpeechPackInstallWithPlanRequest,
  SpeechPackPlanPreviewRequest,
  SpeechPackPlanPreviewResult,
  SpeechPackProgress,
  SpeechPackSnapshot
} from '@shared/speech-pack'

type ComponentId = SpeechPackComponentSnapshot['componentId']
type PackState = SpeechPackComponentSnapshot['state']
type PackProgress = SpeechPackProgress
type PackSnapshot = SpeechPackSnapshot
type Action = SpeechPackActionRequest['action']
type PlanAction = SpeechPackPlanPreviewRequest['action']
type SpeechPackPlan = Extract<SpeechPackPlanPreviewResult, { ok: true }>['plan']
type ReviewedPlan = { value: SpeechPackPlan; manifestIdentity: string; engine: PackSnapshot['selectedEngine'] }
type EngineReadiness = PackSnapshot['engineReadiness']
export type SpeechPackBridge = {
  speechPackState: () => Promise<PackSnapshot>
  speechPackAction: (request: SpeechPackActionRequest) => Promise<SpeechPackActionResult>
  speechPackPlanPreview: (request: SpeechPackPlanPreviewRequest) => Promise<SpeechPackPlanPreviewResult>
  speechPackInstallWithPlan: (request: SpeechPackInstallWithPlanRequest) => Promise<SpeechPackActionResult>
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

function readinessLabel(state: EngineReadiness['state']): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'model-needed':
      return 'Model needed'
    case 'runtime-needed':
      return 'Runtime needed'
    case 'not-configured':
      return 'Runtime not configured'
    case 'incompatible':
      return 'Not compatible with this device'
    case 'repair-needed':
      return 'Needs repair'
    case 'unavailable':
      return 'Unavailable'
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
  const [plan, setPlan] = useState<ReviewedPlan | null>(null)
  const selectionEpoch = useRef(0)

  useEffect(() => {
    const epoch = ++selectionEpoch.current
    let current = true
    setSnapshot(null)
    setProgress(null)
    setPlan(null)
    setMessage(null)
    setBusy(false)
    void bridge
      .speechPackState()
      .then((value) => {
        if (current && epoch === selectionEpoch.current && value.selectedEngine === selectedEngine) {
          setSnapshot(value)
          setProgress(value.progress)
        }
      })
      .catch(() => {
        if (current && epoch === selectionEpoch.current) setMessage('Speech-pack status is unavailable right now.')
      })
    const unsubscribe = bridge.onSpeechPackProgress((value) => {
      if (current && epoch === selectionEpoch.current) setProgress(value)
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [bridge, selectedEngine])

  const currentSnapshot = snapshot?.selectedEngine === selectedEngine ? snapshot : null
  const selected = currentSnapshot?.selectedComponent
  const row = currentSnapshot?.components.find((component) => component.componentId === selected)
  const engineReadiness = currentSnapshot?.engineReadiness
  const selectedReadiness = engineReadiness?.engine === currentSnapshot?.selectedEngine ? engineReadiness : undefined
  const live =
    progress && progress.componentId === selected && progress.manifestIdentity === row?.manifestIdentity
      ? progress
      : null
  const state = live?.state ?? row?.state ?? 'not-installed'
  const active = state === 'queued' || state === 'downloading' || state === 'verifying' || state === 'self-testing'
  const planAction: PlanAction =
    state === 'repair-needed' ||
    selectedReadiness?.state === 'repair-needed' ||
    (state === 'ready' && selectedReadiness?.state === 'runtime-needed')
      ? 'repair'
      : 'install'
  const canReviewPlan =
    !!selectedReadiness &&
    ['ready', 'model-needed', 'runtime-needed', 'repair-needed'].includes(selectedReadiness.state) &&
    row?.state !== 'not-configured'
  const displayedState = !selectedReadiness
    ? 'Engine status unavailable'
    : selectedReadiness.state !== 'ready' && !active
      ? readinessLabel(selectedReadiness.state)
      : labelFor(state)
  const run = async (action: Extract<Action, 'pause' | 'cancel'>): Promise<void> => {
    if (!row) return
    const epoch = selectionEpoch.current
    setBusy(true)
    setMessage(null)
    try {
      const result = await bridge.speechPackAction({
        componentId: row.componentId,
        action,
        manifestIdentity: row.manifestIdentity
      })
      if (!result.ok && epoch === selectionEpoch.current)
        setMessage(
          result.reason === 'policy-blocked'
            ? 'Downloads are disabled by your organization.'
            : 'This action is not available right now.'
        )
    } catch {
      if (epoch === selectionEpoch.current) setMessage('Could not update this speech pack.')
    } finally {
      if (epoch === selectionEpoch.current) setBusy(false)
    }
  }

  const reviewPlan = async (action: PlanAction): Promise<void> => {
    if (!row) {
      setMessage('An approved install plan is not available for this component.')
      return
    }
    const epoch = selectionEpoch.current
    const reviewedSnapshot = currentSnapshot
    if (!reviewedSnapshot) return
    setBusy(true)
    setMessage(null)
    setPlan(null)
    try {
      const result = await bridge.speechPackPlanPreview({
        componentId: row.componentId,
        manifestIdentity: row.manifestIdentity,
        action
      })
      if (epoch !== selectionEpoch.current) return
      if (!result.ok) {
        setMessage(
          result.reason === 'policy-blocked'
            ? 'Downloads are disabled by your organization.'
            : result.reason === 'not-configured'
              ? 'An approved runtime package is not configured for this component yet.'
              : 'An install plan is not available right now.'
        )
      } else if (
        result.plan.selectedComponent !== row.componentId ||
        result.plan.action !== action ||
        result.plan.profile !== reviewedSnapshot.profile ||
        result.plan.profileIdentity !== reviewedSnapshot.packageProfile.identity
      ) {
        setMessage('The install plan no longer matches the selected speech component. Refresh and try again.')
      } else {
        setPlan({ value: result.plan, manifestIdentity: row.manifestIdentity, engine: reviewedSnapshot.selectedEngine })
      }
    } catch {
      if (epoch === selectionEpoch.current) setMessage('Could not review an install plan for this speech component.')
    } finally {
      if (epoch === selectionEpoch.current) setBusy(false)
    }
  }

  const executePlan = async (): Promise<void> => {
    if (!plan || busy) return
    const epoch = selectionEpoch.current
    if (
      !currentSnapshot ||
      !row ||
      row.componentId !== plan.value.selectedComponent ||
      row.manifestIdentity !== plan.manifestIdentity ||
      currentSnapshot.selectedEngine !== plan.engine ||
      currentSnapshot.profile !== plan.value.profile ||
      currentSnapshot.packageProfile.identity !== plan.value.profileIdentity
    ) {
      setPlan(null)
      setMessage('The selected speech component changed. Review a new install plan.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await bridge.speechPackInstallWithPlan({ planId: plan.value.planId, action: plan.value.action })
      if (epoch !== selectionEpoch.current) return
      if (!result.ok) {
        setMessage(
          result.reason === 'policy-blocked'
            ? 'Downloads are disabled by your organization.'
            : 'This install plan expired or is no longer available. Review a new plan.'
        )
      } else {
        setProgress({
          componentId: plan.value.selectedComponent,
          manifestIdentity: row.manifestIdentity,
          bytesDone: 0,
          bytesTotal: Math.max(plan.value.totalDownloadBytes, 1),
          state: 'queued'
        })
      }
      setPlan(null)
      const fresh = await bridge.speechPackState().catch(() => null)
      if (fresh && epoch === selectionEpoch.current && fresh.selectedEngine === selectedEngine) {
        setSnapshot(fresh)
        setProgress(fresh.progress)
      }
    } catch {
      if (epoch === selectionEpoch.current) {
        setMessage('Could not start the reviewed speech-pack install plan.')
        setPlan(null)
      }
    } finally {
      if (epoch === selectionEpoch.current) setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--cl-border)] bg-white/[0.02] p-3">
      <h3 className="text-[13px] font-medium text-[color:var(--cl-foreground)]">On-device speech model</h3>
      <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Download is optional and starts only when you choose it. Métis checks the files and tests the model on this
        device before using it.
      </p>
      {!currentSnapshot ? (
        <p className="mt-2 text-[11px]">Loading model status…</p>
      ) : currentSnapshot.profileError ? (
        <p role="alert" className="mt-2 text-[11px] text-amber-300">
          Speech-pack settings need repair. Reinstall the official Métis package.
        </p>
      ) : !row ? (
        <p className="mt-2 text-[11px]">Apple on-device speech is selected; it does not use an optional model pack.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span>
              {currentSnapshot.selectedEngine === 'whisper' ? 'Whisper base' : 'Parakeet'} · {displayedState}
            </span>
            <span>{sizeLabel(row.downloadBytes)}</span>
          </div>
          {selectedReadiness?.state === 'runtime-needed' && (
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">
              The selected model is present, but its compatible local runtime is missing.
            </p>
          )}
          {!selectedReadiness && (
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">
              Engine availability could not be verified. Refresh status before using this model.
            </p>
          )}
          {selectedReadiness?.state === 'not-configured' && (
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">
              An approved runtime package is not configured for this engine yet.
            </p>
          )}
          {selectedReadiness?.state === 'incompatible' && (
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">
              This engine cannot run with the installed package on this device.
            </p>
          )}
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
            {!active && state !== 'ready' && canReviewPlan && (
              <button
                type="button"
                disabled={busy || !currentSnapshot.featureEnabled}
                onClick={() => void reviewPlan(planAction)}
                className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
              >
                {planAction === 'repair' ? 'Review repair' : 'Review install'}
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
            {state === 'ready' && canReviewPlan && (
              <button
                type="button"
                disabled={busy || !currentSnapshot.featureEnabled}
                onClick={() => void reviewPlan('repair')}
                className="rounded border px-2 py-1 text-[11px] disabled:opacity-50"
              >
                Review repair
              </button>
            )}
            {plan && (
              <div className="basis-full rounded-lg border border-[var(--cl-border)] bg-white/[0.03] p-2.5 text-[11px]">
                <p className="m-0 font-medium text-[color:var(--cl-foreground)]">Review this optional install</p>
                <p className="mt-1 text-[color:var(--cl-muted-foreground)]">
                  {sizeLabel(plan.value.totalDownloadBytes)} download · {sizeLabel(plan.value.totalStorageBytes)}{' '}
                  storage
                </p>
                <ul className="my-1 list-disc pl-4 text-[color:var(--cl-muted-foreground)]">
                  {plan.value.missingComponents.map((item) => (
                    <li key={`${item.componentId}:${item.manifestIdentity}`}>
                      {item.componentId} · {sizeLabel(item.downloadBytes)} download · {sizeLabel(item.storageBytes)}{' '}
                      storage
                      {item.sourceHost ? ` · ${item.sourceHost}` : ''}
                      {item.license ? ` · ${item.license}` : ''}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void executePlan()}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    {plan.value.action === 'repair' ? 'Repair selected components' : 'Install selected components'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPlan(null)}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
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
