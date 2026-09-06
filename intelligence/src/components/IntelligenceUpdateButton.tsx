import { useState, type ReactElement } from 'react'
import { runIntelligenceUpdateClick } from '../lib/intelligence-update'

/**
 * Dashboard Update Intelligence. Shows Updating immediately, then a filled dashboard (via the
 * existing status poll) or a loud error. Never a silent no-op.
 */
export function IntelligenceUpdateButton({
  onUpdated
}: {
  onUpdated?: () => void
}): ReactElement | null {
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!window.intelligence?.backfill) return null

  const onClick = (): void => {
    setUpdating(true)
    setError(null)
    void (async () => {
      const { error: clickError } = await runIntelligenceUpdateClick(() => window.intelligence!.backfill())
      if (clickError) setError(clickError)
      else onUpdated?.()
      setUpdating(false)
    })()
  }

  return (
    <div className="win-no-drag flex max-w-[280px] flex-col items-end gap-1">
      <button
        type="button"
        data-intelligence-update=""
        onClick={onClick}
        disabled={updating}
        aria-busy={updating || undefined}
        title="Recap missing summaries and extract people, accounts, deals, coaching, and Today"
        className="rounded-md bg-mantu px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-mantu/90 disabled:opacity-50"
      >
        {updating ? 'Updating…' : 'Update Intelligence'}
      </button>
      {error && (
        <div className="text-right text-[11px] text-rose-300" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
