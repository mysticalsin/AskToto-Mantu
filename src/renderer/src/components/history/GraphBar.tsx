import { useEffect, useState } from 'react'
import { ExternalLink, Network } from 'lucide-react'
import { TextButton } from '../ui'
import { InlineOrb } from '../AgentStatus'
import { WorkProgressMeter } from '../WorkProgressMeter'
import { describeMeetingIndexProgress } from '../work-progress'
import { IntelligenceUpdateButton } from '../IntelligenceUpdateButton'
import { runIntelligenceUpdateClick } from '../../lib/intelligence-update'
import { brainStatusError, brainStatusIsWorking } from '../brain-status-refresh'
import { INTELLIGENCE_STATUS_UNAVAILABLE } from '@shared/intelligence-pass'
import { countLabel } from './recall-view-helpers'

/** History's Mantu Intelligence status bar: what the brain holds, an update action, and the dashboard link. */
function formatLastIndexedAt(at?: number): string {
  if (!at || !Number.isFinite(at) || at <= 0) return ''
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function GraphBar({
  onOpenSettings,
  onDashboardOpen
}: {
  onOpenSettings?: () => void
  /** Called once the full Mantu Intelligence dashboard window actually opened successfully. */
  onDashboardOpen?: () => void
}): JSX.Element | null {
  // Mantu Intelligence — the meeting brain (people, accounts, deals, win/loss reasons, graph).
  // Replaces the old graphify note-graph as the "open graph" surface in History.
  const [brain, setBrain] = useState<import('@shared/brain').BrainStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  // Distinguishes the deferred "no-provider" error (fixable via Settings → AI) from any other backfill
  // failure (network blip, etc.) — only the former gets an Open Settings action below.
  const [noProvider, setNoProvider] = useState(false)
  const applyStatus = (st: import('@shared/brain').BrainStatus | null): void => {
    setBrain(st)
    setStatusError(st ? null : INTELLIGENCE_STATUS_UNAVAILABLE)
    if (st?.intelligenceIndex?.running) setError(null)
  }
  useEffect(() => {
    void window.toto
      .brainStatus()
      .then(applyStatus)
      .catch(() => setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE))
  }, [])

  // Historical batches and newly saved/imported meetings both update in main. Keep a lightweight status
  // poll alive while this panel is visible: a live job can start after this component mounted, and a
  // permanent 5s idle poll is cheaper and more reliable than a filesystem watcher over OneDrive.
  const liveRunning = !!brain?.live?.running
  const preparing = !!brain?.backfill?.preparing
  const brainWorking = brainStatusIsWorking(brain) || busy
  useEffect(() => {
    const iv = setInterval(
      () => {
        void window.toto
          .brainStatus()
          .then(applyStatus)
          .catch(() => setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE))
      },
      brainWorking ? 1000 : 5000
    )
    return () => clearInterval(iv)
  }, [brainWorking])

  const backfill = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNoProvider(false)
    try {
      const { error: clickError } = await runIntelligenceUpdateClick(() => window.toto.brainBackfill())
      if (clickError) {
        setError(clickError)
        setNoProvider(/provider/i.test(clickError))
        return
      }
      applyStatus(await window.toto.brainStatus())
    } catch {
      setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE)
    } finally {
      setBusy(false)
    }
  }

  const openDashboard = async (): Promise<void> => {
    const r = await window.toto.brainOpenDashboard().catch((e) => ({ ok: false, error: String(e) }))
    if (!r.ok) setError(r.error || 'Could not open Mantu Intelligence.')
    else onDashboardOpen?.()
  }

  const backfilling = !!brain?.backfill?.running || preparing
  const livePending = brain?.live?.pending ?? 0
  const backfillFailed = brain?.backfill?.failed ?? 0
  const indexProgress = brain?.backfill ? describeMeetingIndexProgress(brain.backfill) : null
  const lastIndexed = formatLastIndexedAt(brain?.lastIndexedAt)
  const updating = brainWorking
  const displayError = error || statusError || brainStatusError(brain)
  return (
    <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 text-[11px] text-[color:var(--color-ink-2)]">
          <div className="flex items-center gap-1.5">
            <Network size={12} className="shrink-0 text-[var(--color-accent)]" />
            {displayError ? (
              <span className="text-[var(--color-danger)]">{displayError}</span>
            ) : updating ? (
              <span aria-atomic="true" aria-live="polite">
                {backfilling && indexProgress
                  ? indexProgress.label
                  : liveRunning
                    ? `Updating Intelligence from ${livePending} new meeting${livePending === 1 ? '' : 's'}…`
                    : 'Updating…'}
              </span>
            ) : backfillFailed > 0 && indexProgress ? (
              <span className="text-[var(--color-danger)]" role="alert">
                {indexProgress.label}. Retry Update Intelligence after checking AI settings.
              </span>
            ) : brain && brain.meetings > 0 ? (
              <>
                Intelligence · {countLabel(brain.meetings, 'meeting')} · {countLabel(brain.people, 'person', 'people')}{' '}
                · {countLabel(brain.accounts, 'account')}
                {brain.deals > 0 ? ` · ${countLabel(brain.deals, 'deal')}` : ''}
              </>
            ) : (
              'Mantu Intelligence: build a brain from your meetings.'
            )}
          </div>
          {lastIndexed && !displayError && !updating && (
            <div className="mt-0.5 text-[10px] text-[color:var(--color-ink-3)]">Last indexed {lastIndexed}</div>
          )}
          {updating && (
            <div className="mt-1.5 flex items-center gap-2">
              <InlineOrb kind="searching" />
              {backfilling && indexProgress && (
                <WorkProgressMeter
                  active
                  ariaLabel="Mantu Intelligence meeting index progress"
                  className="min-w-0 flex-1"
                  percent={indexProgress.percent}
                  valueText={indexProgress.valueText}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {noProvider && onOpenSettings && <TextButton onClick={onOpenSettings}>Open Settings</TextButton>}
          <IntelligenceUpdateButton
            variant="text"
            updating={updating}
            disabled={busy}
            onClick={() => void backfill()}
          />
          <TextButton onClick={() => void openDashboard()} title="Open the Mantu Intelligence dashboard">
            <ExternalLink size={11} /> Mantu Intelligence
          </TextButton>
        </div>
      </div>
    </div>
  )
}
