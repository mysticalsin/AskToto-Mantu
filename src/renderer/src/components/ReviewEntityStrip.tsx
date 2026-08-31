import { useEffect, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import type { BrainRead, Confidence, EntityKind, MeetingExtraction } from '@shared/brain'
import { Chip, TextButton } from './ui'
import { InlineOrb } from './AgentStatus'

/**
 * "Entities in this meeting" strip (Task MI-3) — the moment-of-truth correction surface. Renders one
 * dismissible row of entity chips (people / account / deal, each with its extraction-confidence badge)
 * right after a meeting saves, so a misheard name can be fixed while the meeting is still warm.
 *
 * Zero layout shift by construction: nothing renders until the meeting's extraction actually exists
 * (extraction is async post-save — polled every 2s for up to 60s, then stops silently), and nothing
 * ever renders when the brain is off (brainStatus() returns null when signed out — the same "brain off"
 * gate RecallView's Intelligence bar uses).
 */

// ── Pure decision helpers (TDD'd in ReviewEntityStrip.test.ts) ───────────────────────────────────────

export const STRIP_POLL_INTERVAL_MS = 2000
export const STRIP_POLL_TIMEOUT_MS = 60_000

/** Poll stop conditions: keep polling only while there is no extraction yet AND the 60s budget hasn't
 *  run out. Both stops are silent — a meeting that never extracts (too short, no provider) simply never
 *  grows a strip. */
export function shouldPollAgain(elapsedMs: number, extraction: MeetingExtraction | null): boolean {
  if (extraction) return false
  return elapsedMs < STRIP_POLL_TIMEOUT_MS
}

export interface StripChip {
  kind: EntityKind
  name: string
  confidence: Confidence
  /** The entity's slug id, resolved against brainRead — undefined when no live entity matches (chip
   *  renders display-only; there is nothing to rename). */
  id?: string
}

/** The chips one extraction yields: every named person, the account, and the deal (skipping blanks).
 *  Order mirrors the extraction's own emphasis: account first, then people, then the deal. */
export function stripChips(x: MeetingExtraction | null): StripChip[] {
  if (!x) return []
  const chips: StripChip[] = []
  if (x.account && x.account.name.trim()) {
    chips.push({ kind: 'account', name: x.account.name, confidence: x.account.confidence })
  }
  for (const p of x.people) {
    if (p.name.trim()) chips.push({ kind: 'person', name: p.name, confidence: p.confidence })
  }
  if (x.deal && x.deal.name.trim()) {
    // The extraction's deal object carries no own confidence field — a deal chip inherits the account's
    // read when present (a deal is only ever named alongside its account), else EXTRACTED.
    chips.push({ kind: 'deal', name: x.deal.name, confidence: x.account?.confidence ?? 'EXTRACTED' })
  }
  return chips
}

/** Resolve each chip's entity id by exact (case-insensitive) name/alias match against the brain's live
 *  entities. A chip that resolves nothing stays id-less (display-only). Pure — no IPC here. */
export function resolveEntityIds(chips: StripChip[], read: BrainRead): StripChip[] {
  const index = new Map<string, string>()
  const register = (kind: EntityKind, name: string, id: string): void => {
    const key = `${kind}:${name.trim().toLowerCase()}`
    if (!index.has(key)) index.set(key, id)
  }
  for (const p of read.people) {
    register('person', p.name, p.id)
    for (const a of p.aliases) register('person', a, p.id)
  }
  for (const a of read.accounts) {
    register('account', a.name, a.id)
    for (const al of a.aliases) register('account', al, a.id)
  }
  for (const d of read.deals) {
    register('deal', d.name, d.id)
    for (const al of d.aliases) register('deal', al, d.id)
  }
  return chips.map((c) => ({ ...c, id: index.get(`${c.kind}:${c.name.trim().toLowerCase()}`) }))
}

/** Confidence → badge rendering decision: EXTRACTED is plain (no badge), INFERRED gets a hollow badge,
 *  AMBIGUOUS a warning-tinted one. */
export function confidenceBadge(c: Confidence): { label: string; variant: 'hollow' | 'warn' } | null {
  if (c === 'INFERRED') return { label: 'inferred', variant: 'hollow' }
  if (c === 'AMBIGUOUS') return { label: 'unsure', variant: 'warn' }
  return null
}

// ── The strip itself ─────────────────────────────────────────────────────────────────────────────────

// Same 'mixed' amber BrainView uses for warning-tinted state (contrast-validated on the glass surface).
const WARN_COLOR = '#e0af68'

function Badge({ badge }: { badge: { label: string; variant: 'hollow' | 'warn' } }): JSX.Element {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
      style={
        badge.variant === 'warn'
          ? { color: WARN_COLOR, background: 'rgba(224,175,104,0.12)' }
          : { color: 'var(--color-ink-3)', border: '1px solid var(--color-hair-soft)' }
      }
    >
      {badge.label}
    </span>
  )
}

export function ReviewEntityStrip({ file }: { file: string | null }): JSX.Element | null {
  const [chips, setChips] = useState<StripChip[] | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [alsoFixAsr, setAlsoFixAsr] = useState(true)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Poll for the meeting's extraction once a save lands — every 2s, up to 60s, silent stop.
  useEffect(() => {
    setChips(null)
    setDismissed(false)
    setEditing(null)
    setNote(null)
    if (!file) return
    let cancelled = false
    let timer: number | undefined
    const startedAt = Date.now()
    const tick = async (): Promise<void> => {
      try {
        const x = await window.toto.brainMeetingExtraction(file)
        if (cancelled) return
        if (x) {
          const read = await window.toto.brainRead()
          if (cancelled) return
          setChips(resolveEntityIds(stripChips(x), read))
          return
        }
      } catch {
        /* silent — the strip simply never appears */
      }
      if (cancelled) return
      if (shouldPollAgain(Date.now() - startedAt, null)) {
        timer = window.setTimeout(() => void tick(), STRIP_POLL_INTERVAL_MS)
      }
    }
    // Brain-off gate first (signed out → brainStatus() returns null): render nothing, no polling at all.
    void window.toto
      .brainStatus()
      .then((status) => {
        if (!cancelled && status) void tick()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [file])

  if (!file || dismissed || !chips || chips.length === 0) return null

  const startEdit = (i: number): void => {
    setEditing(i)
    setDraft(chips[i].name)
    setAlsoFixAsr(true)
    setNote(null)
  }

  const saveRename = async (): Promise<void> => {
    if (editing === null) return
    const chip = chips[editing]
    const newName = draft.trim()
    if (!chip.id || !newName || newName === chip.name || saving) return
    setSaving(true)
    try {
      const r = await window.toto.brainEntityRename(chip.kind, chip.id, newName, alsoFixAsr)
      if (r.ok) {
        setChips(chips.map((c, i) => (i === editing ? { ...c, name: newName } : c)))
        setEditing(null)
        if (r.asrSkipped && r.reason) setNote(r.reason)
      } else {
        setNote(r.error || 'Could not rename.')
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const editingChip = editing !== null ? chips[editing] : null

  return (
    <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
          In this meeting
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chips.map((c, i) => {
            const badge = confidenceBadge(c.confidence)
            return (
              <Chip
                key={`${c.kind}:${c.name}`}
                onClick={() => (c.id ? startEdit(i) : undefined)}
                title={c.id ? `Correct "${c.name}"` : c.name}
                disabled={!c.id}
              >
                <span className="truncate">{c.name}</span>
                {badge && <Badge badge={badge} />}
              </Chip>
            )
          })}
        </div>
        <TextButton icon={X} ariaLabel="Dismiss" title="Dismiss" onClick={() => setDismissed(true)} />
      </div>

      {editingChip && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-3)]">
            <Pencil size={11} /> Correct name
          </div>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setEditing(null)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                void saveRename()
              }
            }}
            className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
          />
          <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-3)]">
            <input
              type="checkbox"
              checked={alsoFixAsr}
              onChange={(e) => setAlsoFixAsr(e.target.checked)}
              className="no-drag"
            />
            Also fix live transcription going forward
          </label>
          <div className="flex items-center gap-1">
            <Chip
              onClick={() => void saveRename()}
              variant="accent"
              disabled={saving || !draft.trim() || draft.trim() === editingChip.name}
            >
              {saving ? <InlineOrb kind="loading" /> : <Check size={12} />}
              {saving ? 'Saving' : 'Save'}
            </Chip>
            <TextButton onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </TextButton>
          </div>
        </div>
      )}

      {note && <div className="mt-1.5 text-[11px] text-[color:var(--color-ink-3)]">{note}</div>}
    </div>
  )
}
