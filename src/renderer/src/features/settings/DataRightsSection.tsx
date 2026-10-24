/**
 * DataRightsSection.tsx — Settings › Meetings › Your data (G82, CAP-35).
 * Two actions: export what Métis holds for this account, and erase it. Erasing is destructive, so it always goes
 * through the confirm card with the exact preview main returned; the receipt that follows names every place that
 * was erased and every one that could not be (a copy in the cloud, a record an organisation keeps).
 */
import { useEffect, useState } from 'react'
import { Download, ShieldAlert, Trash2 } from 'lucide-react'
import type { ErasureReceipt } from '@shared/data-rights'
import { Section } from '../../ui/Section'
import { useConfirm } from '../../ui/confirm-context'
import { erasureConfirmation, receiptSummary, refusalText } from './data-rights-copy'

const BUTTON =
  'no-drag cl-focus flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[12px] font-medium disabled:opacity-50'

export function DataRightsSection(): JSX.Element {
  const askToConfirm = useConfirm()
  const [busy, setBusy] = useState<'erase' | 'export' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ErasureReceipt | null>(null)

  useEffect(() => {
    // A host without the bridge (a standalone render) simply shows no previous receipt.
    void Promise.resolve()
      .then(() => window.toto.dataRights?.lastReceipt())
      .then((r) => {
        if (r?.ok) setReceipt(r.receipt)
      })
      .catch(() => undefined)
  }, [])

  const erase = async (): Promise<void> => {
    setBusy('erase')
    setMessage(null)
    try {
      const preview = await window.toto.dataRights.preview()
      if (!preview.ok) return setMessage(refusalText(preview.reason))
      if (!(await askToConfirm(erasureConfirmation(preview)))) return setMessage('Cancelled. Nothing was erased.')
      const done = await window.toto.dataRights.confirm(preview.proposalId, preview.previewHash)
      if (!done.ok) return setMessage(refusalText(done.reason))
      setReceipt(done.receipt)
    } finally {
      setBusy(null)
    }
  }

  const exportData = async (): Promise<void> => {
    setBusy('export')
    setMessage(null)
    try {
      const result = await window.toto.dataRights.exportData()
      if (!result.ok) return setMessage(refusalText(result.reason))
      if (result.cancelled) return setMessage('Cancelled. Nothing was exported.')
      setMessage(
        `Exported ${result.records} item${result.records === 1 ? '' : 's'}.` +
          (result.skipped > 0 ? ` ${result.skipped} not downloaded to this device were skipped.` : '')
      )
    } finally {
      setBusy(null)
    }
  }

  const summary = receipt ? receiptSummary(receipt) : null
  return (
    <Section
      title="Your data"
      desc="Take a copy of what Métis holds for this account, or erase it from this device."
      icon={ShieldAlert}
    >
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Export my data</div>
          Your meetings and assistants as plain files, with a list that says where each came from.
        </div>
        <button
          type="button"
          onClick={() => void exportData()}
          disabled={busy !== null}
          className={`${BUTTON} border-[var(--cl-input)] bg-white/[0.04] text-[color:var(--cl-foreground)] hover:bg-white/[0.08]`}
        >
          <Download size={13} /> {busy === 'export' ? 'Exporting…' : 'Export'}
        </button>
      </div>
      <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3 py-2.5">
        <div className="min-w-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Erase my Métis data</div>
          Removes your meetings, notes, memory, assistants and caches from this device and gives you a receipt.
        </div>
        <button
          type="button"
          onClick={() => void erase()}
          disabled={busy !== null}
          className={`${BUTTON} border-[var(--cl-destructive)]/40 bg-[var(--cl-destructive)]/15 text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/25`}
        >
          <Trash2 size={13} /> {busy === 'erase' ? 'Erasing…' : 'Erase'}
        </button>
      </div>
      {message && (
        <div role="status" className="mt-2 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
          {message}
        </div>
      )}
      {summary && (
        <div className="mt-2 px-1 text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
          <div className="font-medium text-[color:var(--cl-foreground)]">{summary.headline}</div>
          <ul className="m-0 list-disc pl-4">
            {summary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}
