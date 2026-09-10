import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  clearRecoveredIntelligenceUpdateError,
  createIntelligenceUpdateAttempt,
  intelligenceUpdateViewState,
  type IntelligenceUpdateViewState
} from '../lib/intelligence-update'
import type { BrainStatusSnapshot } from '../lib/status-refresh'

// MQA-290: return ReactElement. Totos-Mac tsc -b has no global JSX namespace.

/**
 * Dashboard Update Intelligence. Shows Updating immediately, then a filled dashboard (via the
 * existing status poll) or a loud error. Never a silent no-op.
 */
export function IntelligenceUpdateButton({
  status,
  refreshStatus
}: {
  status: BrainStatusSnapshot | null
  refreshStatus: () => Promise<BrainStatusSnapshot | null>
}): ReactElement | null {
  const [local, setLocal] = useState<IntelligenceUpdateViewState>({
    busy: false,
    error: null,
    errorKind: null
  })
  const attemptRef = useRef<ReturnType<typeof createIntelligenceUpdateAttempt> | null>(null)
  if (!attemptRef.current) attemptRef.current = createIntelligenceUpdateAttempt(setLocal)

  useEffect(() => {
    if (status && !status.error) setLocal(clearRecoveredIntelligenceUpdateError)
  }, [status])

  if (!window.intelligence?.backfill) return null

  const view = intelligenceUpdateViewState(
    local,
    status?.error ? { running: false, lastError: status.error } : status?.intelligenceIndex
  )
  const onClick = (): void => {
    void attemptRef.current!.run(
      () => window.intelligence!.backfill(),
      async () => {
        const refreshed = await refreshStatus()
        return refreshed?.error
          ? { running: false, lastError: refreshed.error }
          : refreshed?.intelligenceIndex ?? null
      }
    )
  }

  return (
    <div className="win-no-drag flex max-w-[280px] flex-col items-end gap-1">
      <button
        type="button"
        data-intelligence-update=""
        onClick={onClick}
        disabled={view.busy}
        aria-busy={view.busy || undefined}
        title="Recap missing summaries and extract people, accounts, deals, coaching, and Today"
        className="rounded-md bg-mantu px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-mantu/90 disabled:opacity-50"
      >
        {view.busy ? 'Updating…' : 'Update Intelligence'}
      </button>
      {view.error && (
        <div className="text-right text-[11px] text-rose-300" role="alert">
          {view.error}
        </div>
      )}
    </div>
  )
}
