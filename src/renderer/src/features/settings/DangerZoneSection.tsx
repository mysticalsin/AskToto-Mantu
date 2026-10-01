import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react'
import type { PreservedBrainIndexCopy, PublicSettings } from '@shared/ipc'
import { Section } from '../../ui/Section'
import { ctl } from '../../ui/ctl'

const RETENTION_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: 'Keep forever (default)' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' }
]

function formatPreservedIndexSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

/** GDPR/CCPA-facing controls: auto-retention window + a real "delete everything" action. Meeting
 *  recordings capture OTHER people's speech, not just the operator's — this is the one place in
 *  Settings that lets that be bounded or fully erased on demand, not just left to manual per-file cleanup. */
export function DangerZoneSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; deleted: number; error?: string } | null>(null)
  const [preservedBusy, setPreservedBusy] = useState<string | null>(null)
  const [preservedMsg, setPreservedMsg] = useState<string | null>(null)
  const [preservedCopies, setPreservedCopies] = useState<PreservedBrainIndexCopy[]>([])

  const refreshPreservedCopies = useCallback(async (): Promise<void> => {
    const r = await window.toto.preservedBrainIndexesList()
    setPreservedCopies(r.copies)
  }, [])

  useEffect(() => {
    void refreshPreservedCopies()
  }, [refreshPreservedCopies])

  const deleteAll = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    const r = await window.toto.recallDeleteAll()
    setResult(r)
    setBusy(false)
  }

  const restorePreserved = async (id: string): Promise<void> => {
    setPreservedBusy(id)
    setPreservedMsg(null)
    const r = await window.toto.preservedBrainIndexRestore(id)
    setPreservedMsg(r.ok ? 'Restored the preserved brain index.' : r.error === 'cancelled' ? 'Cancelled. Nothing was changed.' : r.error || 'Could not restore that preserved copy.')
    await refreshPreservedCopies()
    setPreservedBusy(null)
  }

  const deletePreserved = async (id: string): Promise<void> => {
    setPreservedBusy(id)
    setPreservedMsg(null)
    const r = await window.toto.preservedBrainIndexDelete(id)
    setPreservedMsg(r.ok ? 'Deleted the preserved brain index copy.' : r.error === 'cancelled' ? 'Cancelled. Nothing was deleted.' : r.error || 'Could not delete that preserved copy.')
    await refreshPreservedCopies()
    setPreservedBusy(null)
  }

  return (
    <Section
      title="Danger zone"
      desc="Meeting recordings capture other people's speech too, not just yours, so these controls bound or fully erase what's stored on this device."
      icon={AlertCircle}
    >
      <label className="mb-1 block text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
        Auto-delete meetings older than
      </label>
      <select
        value={settings.transcriptRetentionDays}
        onChange={(e) => patch({ transcriptRetentionDays: Number(e.target.value) })}
        disabled={settings.managedKeys.includes('transcriptRetentionDays')}
        aria-label="Auto-delete meetings older than"
        className={'w-full ' + ctl}
      >
        {RETENTION_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Delete all my data</div>
          <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Permanently removes every saved meeting, note, and the knowledge graph from this device. Cannot be undone.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void deleteAll()}
          disabled={busy}
          className="no-drag cl-focus flex shrink-0 items-center gap-1.5 rounded-[10px] border border-[var(--cl-destructive)]/40 bg-[var(--cl-destructive)]/15 px-3 py-2 text-[12px] font-medium text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/25 disabled:opacity-50"
        >
          <Trash2 size={13} /> {busy ? 'Deleting…' : 'Delete everything'}
        </button>
      </div>
      {preservedCopies.length > 0 && (
        <div className="mt-4 space-y-2">
          <div>
            <div className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Preserved brain indexes</div>
            <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Copies kept after rebuilds or restores. Settings shows only date, size, and whether this install can unlock them.
            </div>
          </div>
          {preservedCopies.map((copy) => (
            <div
              key={copy.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--cl-input)] bg-white/[0.03] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-[color:var(--cl-foreground)]">
                  {new Date(copy.createdAt).toLocaleString()}
                </div>
                <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">
                  {formatPreservedIndexSize(copy.size)} · {copy.restorable ? 'Can restore on this install' : 'Locked on this install'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {copy.restorable && (
                  <button
                    type="button"
                    onClick={() => void restorePreserved(copy.id)}
                    disabled={preservedBusy !== null}
                    className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50"
                  >
                    <RotateCcw size={13} /> Restore
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void deletePreserved(copy.id)}
                  disabled={preservedBusy !== null}
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[10px] border border-[var(--cl-destructive)]/40 bg-[var(--cl-destructive)]/10 px-3 py-2 text-[12px] text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20 disabled:opacity-50"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
          {preservedMsg && <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">{preservedMsg}</div>}
        </div>
      )}
      {result && (
        <div
          className={[
            'mt-2 text-[11px]',
            result.ok || result.error === 'cancelled'
              ? 'text-[color:var(--cl-muted-foreground)]'
              : 'text-[color:var(--cl-destructive)]'
          ].join(' ')}
        >
          {result.error === 'cancelled'
            ? 'Cancelled. Nothing was deleted.'
            : result.ok
              ? `Deleted ${result.deleted} meeting${result.deleted === 1 ? '' : 's'}.`
              : result.error
                ? result.error
                : `Deleted ${result.deleted}, but some files could not be removed.`}
        </div>
      )}
    </Section>
  )
}
