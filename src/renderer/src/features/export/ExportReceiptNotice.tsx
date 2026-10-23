import { useCallback, useState } from 'react'
import type { ExportReceipt } from '@shared/ipc'
import { TextButton } from '../../components/ui'

/** What every export channel returns; the notice only needs these fields. */
export interface ExportResultLike {
  ok: boolean
  cancelled?: boolean
  error?: string
  receipt?: ExportReceipt
}

type NoticeState = { receipt: ExportReceipt } | { error: string } | null

/** "Exported to ..." with Open and Reveal for a finished export, or the honest failure. The renderer sends
 *  only the receipt id; main resolves the path from its local receipt log. */
export function ExportReceiptNotice({ receipt }: { receipt: ExportReceipt }): JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)
  const act = (action: 'open' | 'reveal'): void => {
    setProblem(null)
    void window.toto
      .exportReveal({ exportId: receipt.exportId, action })
      .then((r) => {
        if (!r.ok) setProblem(r.error ?? 'Could not show the exported file.')
      })
      .catch(() => setProblem('Could not show the exported file.'))
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-[color:var(--color-ink-2)]" role="status">
      <span className="min-w-0 break-all" title={receipt.sha256}>
        Exported to {receipt.destination}
      </span>
      <TextButton onClick={() => act('open')}>Open</TextButton>
      <TextButton onClick={() => act('reveal')}>Reveal</TextButton>
      {problem && <span className="text-[var(--color-danger)]">{problem}</span>}
    </div>
  )
}

/** Holds the last export outcome and renders it; `report` takes any export channel's result. */
export function useExportNotice(): {
  report: (r: ExportResultLike) => void
  fail: (e: unknown) => void
  node: JSX.Element | null
} {
  const [state, setState] = useState<NoticeState>(null)
  const report = useCallback((r: ExportResultLike): void => {
    if (r.ok && r.receipt) setState({ receipt: r.receipt })
    else setState(!r.ok && !r.cancelled ? { error: r.error ?? 'Export failed; no file was written.' } : null)
  }, [])
  const fail = useCallback((e: unknown): void => {
    setState({ error: e instanceof Error ? e.message : String(e) })
  }, [])
  let node: JSX.Element | null = null
  if (state && 'receipt' in state) node = <ExportReceiptNotice receipt={state.receipt} />
  else if (state) node = <div className="text-[11px] text-[var(--color-danger)]">{state.error}</div>
  return { report, fail, node }
}
