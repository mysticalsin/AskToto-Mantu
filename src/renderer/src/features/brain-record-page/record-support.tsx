import { useMemo, useState } from 'react'
import { Check, ChevronRight, Combine, Pencil, Search, Undo2, X } from 'lucide-react'
import type {
  AccountEntity,
  Band,
  BrainRead,
  DealEntity,
  EntityKind,
  PersonEntity,
  ProvenantField,
  ProvenanceState
} from '@shared/brain'
import { BandSchema, SectorSchema } from '@shared/brain'
import type { AttentionItem } from '@shared/ipc'
import { Chip, TextButton } from '../../components/ui'
import { InlineOrb } from '../../components/AgentStatus'

/** Which entity the record page is currently showing — BrainView owns this as in-component navigation
 *  state (no router), matching how it already handles internal sections. */
export interface BrainRecordRef {
  kind: EntityKind
  id: string
}

// ─── Pure decision helpers (TDD'd in BrainRecordPage.test.ts) ────────────────────────────────────────

/** The React `key` BrainView stamps on this component's element. Its ONLY job: change whenever the
 *  displayed record changes, so React genuinely remounts the page (clearing every FieldCard's
 *  editing/draft/pending and the header rename box) on a direct record→record transition — the
 *  post-merge navigation to the survivor and the post-undo navigation to the restored source. Without a
 *  changing key React reuses the instance and a half-typed edit would save against the WRONG entity, the
 *  one misattribution this whole correction surface exists to prevent. Kept as a single exported helper
 *  so that invariant is unit-testable (a node harness can't render React to assert the remount directly)
 *  and there is one source of truth for the key. */
export function recordKey(ref: BrainRecordRef): string {
  return `${ref.kind}:${ref.id}`
}

/** The provenance chip's label. Three surface forms, keyed off `state` only:
 *   - 'pinned' / 'edited' (a human touched this field) → "edited by you"
 *   - 'verified'                                        → "verified"
 *   - 'extracted' (the default, LLM-only)                → `extracted — "quote" — <meeting>` (quote
 *     omitted when absent; the meeting falls back to "unknown meeting" when source_file is blank, e.g.
 *     a v1-migrated field with no honest source to cite — see store.ts's migrateField doc comment). */
export function provenanceChipLabel(
  field: { state: ProvenanceState; quote?: string; source_file: string } | undefined
): string {
  if (!field) return ''
  if (field.state === 'pinned' || field.state === 'edited') return 'edited by you'
  if (field.state === 'verified') return 'verified'
  const meeting = field.source_file || 'unknown meeting'
  return field.quote ? `extracted: "${field.quote}" (${meeting})` : `extracted (${meeting})`
}

export type MoneyFieldMode =
  | { kind: 'verified'; text: string }
  | { kind: 'unverified'; text: string }
  | { kind: 'absent'; text: string }

/** The deal money card's render-mode invariant: an amount/close_date is only ever shown as a real figure
 *  once a human has verified/pinned/edited it — an 'extracted' (LLM-only) value NEVER renders as a bare
 *  number, no matter how confident the extraction. Absent — no field at all — has its own quiet state,
 *  distinct from "unverified" (a value exists but hasn't been confirmed). */
export function moneyFieldMode<T>(
  field: { state: ProvenanceState; value: T } | undefined,
  formatValue: (v: T) => string
): MoneyFieldMode {
  if (!field) return { kind: 'absent', text: 'Not stated' }
  if (field.state === 'verified' || field.state === 'pinned' || field.state === 'edited') {
    return { kind: 'verified', text: formatValue(field.value) }
  }
  return { kind: 'unverified', text: 'Stated but unverified, pin to confirm' }
}

export function formatAmount(v: { value: number; currency: string }): string {
  return `${v.value.toLocaleString()} ${v.currency}`
}

const ATTENTION_PRIORITY: Record<AttentionItem['kind'], number> = {
  contradicted_pin: 0,
  ambiguous: 1,
  lint: 2,
  // Last: a failed source already has its own always-visible banner + Retry action at the top of
  // BrainView, so this feed entry is a supplement, not the primary way to notice it.
  ingest_failed: 3
}

/** Most-urgent-first ordering for the Attention section: a contradicted pin (a human's own correction
 *  disputed by later evidence) outranks an unreviewed AMBIGUOUS guess, which outranks a lint note, which
 *  outranks a failed-ingest notice. Stable within a kind (Array.sort is stable per spec) and never
 *  mutates its input. */
export function sortAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => ATTENTION_PRIORITY[a.kind] - ATTENTION_PRIORITY[b.kind])
}

/** The "Same as…" merge picker's candidate list: every same-kind entity except the one being viewed,
 *  narrowed by a case-insensitive substring match on name. */
export function filterMergeCandidates<T extends { id: string; name: string }>(
  entities: T[],
  excludeId: string,
  query: string
): T[] {
  const q = query.trim().toLowerCase()
  return entities.filter((e) => e.id !== excludeId && (!q || e.name.toLowerCase().includes(q)))
}

/** Does a rename change the name's SURFACE FORM meaningfully — i.e. beyond casing/diacritics? Mirrors
 *  slugify's own casefold + NFKD diacritic strip (store.ts), because that's exactly the normalization
 *  the ASR correction pair would be fighting: "l'oreal" → "L'Oréal" is a pure spelling fix the
 *  transcript never needs a live substitution for, while "Acme Corp" → "Acme" genuinely changes what
 *  is heard. Gates the "also fix live transcription" checkbox. */
export function isMeaningfulRename(oldName: string, newName: string): boolean {
  const norm = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
  return norm(oldName) !== norm(newName) && norm(newName).length > 0
}

// ─── Small display atoms ──────────────────────────────────────────────────────────────────────────────

function ProvenanceChip({
  field,
  onOpenMeeting
}: {
  field: { state: ProvenanceState; quote?: string; source_file: string } | undefined
  onOpenMeeting?: (file: string) => void
}): JSX.Element | null {
  const label = provenanceChipLabel(field)
  if (!label) return null
  const clickable = field?.state === 'extracted' && !!field.source_file && !!onOpenMeeting
  const className =
    'inline-flex max-w-full items-center truncate rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-ink-3)]'
  if (clickable) {
    return (
      <button
        type="button"
        onClick={() => onOpenMeeting!(field!.source_file)}
        title={label}
        className={`no-drag focus-ring cursor-pointer hover:text-[color:var(--color-ink)] ${className}`}
      >
        {label}
      </button>
    )
  }
  return (
    <span className={className} title={label}>
      {label}
    </span>
  )
}

export const KIND_LABEL: Record<EntityKind, string> = { person: 'Person', account: 'Account', deal: 'Deal' }

// ─── Generic provenant field card (role/org/sector/stage/band/velocity) ─────────────────────────────

export function FieldCard<T>({
  label,
  field,
  formatValue,
  renderEditor,
  defaultValue,
  onOpenMeeting,
  onSave
}: {
  label: string
  field: ProvenantField<T> | undefined
  formatValue: (v: T) => string
  renderEditor: (value: T, onChange: (v: T) => void) => React.ReactNode
  defaultValue: T
  onOpenMeeting?: (file: string) => void
  onSave: (value: T) => Promise<{ ok: boolean; error?: string }>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<T>(field?.value ?? defaultValue)
  // Optimistic in-flight value: shown the moment Save is clicked (editor closes immediately). onSave's
  // ok path refetches the brain (the fresh field then carries this value with 'pinned' provenance); its
  // error path surfaces through the parent's error banner — clearing `pending` then reverts the display
  // to the untouched on-disk value either way.
  const [pending, setPending] = useState<T | null>(null)

  const startEdit = (): void => {
    setDraft(field?.value ?? defaultValue)
    setEditing(true)
  }
  const save = async (): Promise<void> => {
    const value = draft
    setEditing(false)
    setPending(value)
    await onSave(value)
    setPending(null)
  }

  return (
    <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
          {label}
        </span>
        {!editing && pending === null && (
          <TextButton icon={Pencil} ariaLabel={`Edit ${label}`} onClick={startEdit} title={`Edit ${label}`} />
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          {renderEditor(draft, setDraft)}
          <div className="flex items-center gap-1">
            <Chip onClick={() => void save()} variant="accent">
              <Check size={12} /> Save
            </Chip>
            <TextButton onClick={() => setEditing(false)}>
              <X size={11} /> Cancel
            </TextButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[13px] text-[color:var(--color-ink)]">
            {pending !== null ? (
              <>
                <span>{formatValue(pending)}</span>
                <InlineOrb kind="loading" />
              </>
            ) : field ? (
              formatValue(field.value)
            ) : (
              <span className="text-[color:var(--color-ink-3)]">Not stated</span>
            )}
          </div>
          {pending === null && <ProvenanceChip field={field} onOpenMeeting={onOpenMeeting} />}
        </div>
      )}
    </div>
  )
}

// ─── Deal money card (amount + close_date — the verified-only invariant) ────────────────────────────

export function MoneyCard({
  deal,
  onPin
}: {
  deal: DealEntity
  onPin: (field: 'amount' | 'close_date', value: unknown) => Promise<{ ok: boolean; error?: string }>
}): JSX.Element {
  const [pinning, setPinning] = useState<'amount' | 'close_date' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const amountMode = moneyFieldMode(deal.amount, formatAmount)
  const dateMode = moneyFieldMode(deal.close_date, (v) => v)

  const pinExtracted = async (field: 'amount' | 'close_date', value: unknown): Promise<void> => {
    setPinning(field)
    setError(null)
    const r = await onPin(field, value)
    setPinning(null)
    if (!r.ok) setError(r.error || 'Could not pin this value.')
  }

  const Row = ({
    label,
    field,
    mode,
    rawValue
  }: {
    label: string
    field: 'amount' | 'close_date'
    mode: MoneyFieldMode
    rawValue: unknown
  }): JSX.Element => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <span
          className={
            'text-[13px] ' +
            (mode.kind === 'verified' ? 'text-[color:var(--color-ink)]' : 'text-[color:var(--color-ink-3)]')
          }
        >
          {mode.text}
        </span>
        {mode.kind === 'unverified' && (
          <TextButton onClick={() => void pinExtracted(field, rawValue)} disabled={pinning === field}>
            {pinning === field ? <InlineOrb kind="loading" /> : <Check size={11} />} Pin to confirm
          </TextButton>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">Deal value</div>
      <Row label="Amount" field="amount" mode={amountMode} rawValue={deal.amount?.value} />
      <Row label="Close date" field="close_date" mode={dateMode} rawValue={deal.close_date?.value} />
      {error && <div className="text-[11px] text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}

/** A just-completed merge, tracked by the PARENT (BrainView) rather than this component — the record
 *  page remounts fresh on every navigation (including the one confirmMerge itself triggers), so anything
 *  that must survive that navigation (the "Undo" banner) has to live one level up. `intoId` names the
 *  survivor the banner belongs to, so parent-held state that outlives that one navigation can still be
 *  scoped back to the record it is about. */
export interface RecentMerge {
  seq: number
  kind: EntityKind
  fromId: string
  fromLabel: string
  intoId: string
  intoLabel: string
}

/** Does the post-merge "Undo" banner belong on the record currently open? BrainView keeps `recentMerge`
 *  for the rest of the dashboard session — only Undo, Dismiss or the next merge clear it, and Back merely
 *  pops to the dashboard — and hands it to whichever record page is mounted next. Without this gate the
 *  banner follows the user onto unrelated records and offers an Undo that restores two entities that page
 *  never mentions, discarding everything either side gained since the merge (unmergeEntities restores a
 *  point-in-time snapshot). Kept as an exported helper so the scoping is unit-testable without rendering. */
export function mergeBannerApplies(merge: RecentMerge | null | undefined, ref: BrainRecordRef): boolean {
  return !!merge && merge.kind === ref.kind && merge.intoId === ref.id
}

// ─── The record page itself ───────────────────────────────────────────────────────────────────────
