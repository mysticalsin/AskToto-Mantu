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
import { Chip, TextButton, Spinner } from './ui'

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

const ATTENTION_PRIORITY: Record<AttentionItem['kind'], number> = { contradicted_pin: 0, ambiguous: 1, lint: 2 }

/** Most-urgent-first ordering for the Attention section: a contradicted pin (a human's own correction
 *  disputed by later evidence) outranks an unreviewed AMBIGUOUS guess, which outranks a lint note. Stable
 *  within a kind (Array.sort is stable per spec) and never mutates its input. */
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

const KIND_LABEL: Record<EntityKind, string> = { person: 'Person', account: 'Account', deal: 'Deal' }

// ─── Generic provenant field card (role/org/sector/stage/band/velocity) ─────────────────────────────

function FieldCard<T>({
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
                <Spinner size={11} />
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

function MoneyCard({
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
            {pinning === field ? <Spinner size={11} /> : <Check size={11} />} Pin to confirm
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
 *  that must survive that navigation (the "Undo" banner) has to live one level up. */
export interface RecentMerge {
  seq: number
  kind: EntityKind
  fromId: string
  fromLabel: string
  intoLabel: string
}

// ─── The record page itself ───────────────────────────────────────────────────────────────────────

export function BrainRecordPage({
  recordRef,
  data,
  onOpenRecord,
  onOpenMeeting,
  onRefresh,
  onError,
  onMerged,
  recentMerge,
  onUndoMerge,
  onDismissMerge
}: {
  recordRef: BrainRecordRef
  data: BrainRead
  onOpenRecord: (kind: EntityKind, id: string) => void
  onOpenMeeting?: (file: string) => void
  onRefresh: () => Promise<void>
  onError: (msg: string | null) => void
  /** Called right after a successful merge, before navigating to the survivor — lets the parent capture
   *  the seq/labels needed for the post-merge "Undo" banner. */
  onMerged: (merge: RecentMerge) => void
  recentMerge?: RecentMerge | null
  onUndoMerge?: () => void
  onDismissMerge?: () => void
}): JSX.Element {
  const { kind, id } = recordRef
  const person = kind === 'person' ? data.people.find((p) => p.id === id) : undefined
  const account = kind === 'account' ? data.accounts.find((a) => a.id === id) : undefined
  const deal = kind === 'deal' ? data.deals.find((d) => d.id === id) : undefined
  const entity: PersonEntity | AccountEntity | DealEntity | undefined = person ?? account ?? deal

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [alsoFixAsr, setAlsoFixAsr] = useState(false)
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeTarget, setMergeTarget] = useState<{ id: string; name: string } | null>(null)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)

  const sameKindEntities = useMemo(
    () =>
      (kind === 'person' ? data.people : kind === 'account' ? data.accounts : data.deals).map((e) => ({
        id: e.id,
        name: e.name
      })),
    [kind, data]
  )
  const mergeCandidates = useMemo(
    () => filterMergeCandidates(sameKindEntities, id, mergeQuery),
    [sameKindEntities, id, mergeQuery]
  )

  if (!entity) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-4 py-8 text-center text-[12px] text-[color:var(--color-ink-3)]">
        This record no longer exists. It may have been merged into another entity.
      </div>
    )
  }

  const startRename = (): void => {
    setNameDraft(entity.name)
    setAlsoFixAsr(false)
    setRenameError(null)
    setRenaming(true)
  }
  const saveRename = async (): Promise<void> => {
    const newName = nameDraft.trim()
    if (!newName) return
    setRenameSaving(true)
    setRenameError(null)
    const r = await window.toto.brainEntityRename(kind, id, newName, isMeaningfulRename(entity.name, newName) && alsoFixAsr)
    setRenameSaving(false)
    if (r.ok) {
      setRenaming(false)
      await onRefresh()
    } else {
      setRenameError(r.error || 'Could not rename this entity.')
    }
  }

  const saveField = async (field: string, value: unknown): Promise<{ ok: boolean; error?: string }> => {
    const r = await window.toto.brainEntityUpdateField(kind, id, field, value)
    if (r.ok) await onRefresh()
    else onError(r.error || 'Could not save this field.')
    return r
  }

  const confirmMerge = async (): Promise<void> => {
    if (!mergeTarget) return
    setMerging(true)
    setMergeError(null)
    const r = await window.toto.brainEntityMerge(kind, id, mergeTarget.id)
    setMerging(false)
    if (r.ok) {
      const target = mergeTarget
      setMergeOpen(false)
      setMergeTarget(null)
      setMergeQuery('')
      if (r.seq !== undefined) {
        onMerged({ seq: r.seq, kind, fromId: id, fromLabel: entity.name, intoLabel: target.name })
      }
      await onRefresh()
      onOpenRecord(kind, target.id)
    } else {
      setMergeError(r.error || 'Could not merge.')
    }
  }

  const meetings = [...(entity.meetings ?? [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  // Open commitments the record page can act on. A deal's own ledger is authoritative, and its `by`
  // resolves to a person id by name (best-effort — 'you'/'them' never match a real person, so Reject is
  // simply omitted for those rows rather than sent with a guessed slug). A person's ledger entries don't
  // carry which deal they belong to (LedgerCommitmentSchema has no `deal` field), so settling one from a
  // PERSON page needs the owning deal resolved by matching commitment TEXT across every deal —
  // best-effort, matching how BrainView's own "Open promises" rail is deal-keyed.
  const findPersonIdByName = (name: string): string | undefined =>
    data.people.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())?.id

  const openCommitments =
    deal != null
      ? deal.commitments
          .filter((c) => c.status === 'open')
          .map((c) => ({ c, dealName: deal.name, dealId: deal.id, personId: findPersonIdByName(c.by) }))
      : person != null
        ? person.commitments
            .filter((c) => c.status === 'open')
            .map((c) => {
              const owningDeal = data.deals.find((d) =>
                d.commitments.some((dc) => dc.text.trim().toLowerCase() === c.text.trim().toLowerCase())
              )
              return { c, dealName: owningDeal?.name, dealId: owningDeal?.id, personId: person.id }
            })
        : []

  const settle = async (dealName: string, text: string, status: 'kept' | 'broken'): Promise<void> => {
    const r = await window.toto.brainCommitmentSettle(dealName, text, status)
    if (r.ok) await onRefresh()
    else onError(r.error || 'Could not settle this promise.')
  }
  const reject = async (personSlug: string, dealId: string | undefined, text: string): Promise<void> => {
    const r = await window.toto.brainCommitmentReject(personSlug, text, dealId)
    if (r.ok) await onRefresh()
    else onError(r.error || 'Could not reject this commitment.')
  }

  return (
    <div className="flex flex-col gap-3">
      {recentMerge && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-hair-soft)] bg-[var(--color-accent-soft)] px-3 py-2 text-[12px] text-[color:var(--color-ink-2)]">
          <span>
            Merged {recentMerge.fromLabel} into {recentMerge.intoLabel}.
          </span>
          <span className="flex items-center gap-1">
            <TextButton icon={Undo2} onClick={onUndoMerge}>
              Undo
            </TextButton>
            <TextButton icon={X} ariaLabel="Dismiss" onClick={onDismissMerge} />
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-3">
        {renaming ? (
          <div className="flex flex-col gap-1.5">
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setRenaming(false)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  void saveRename()
                }
              }}
              className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[14px] text-[color:var(--color-ink)]"
            />
            {isMeaningfulRename(entity.name, nameDraft) && (
              <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-3)]">
                <input
                  type="checkbox"
                  checked={alsoFixAsr}
                  onChange={(e) => setAlsoFixAsr(e.target.checked)}
                  className="no-drag"
                />
                Also fix live transcription (spell "{entity.name}" as "{nameDraft.trim()}" going forward)
              </label>
            )}
            {renameError && <div className="text-[11px] text-[var(--color-danger)]">{renameError}</div>}
            <div className="flex items-center gap-1">
              <Chip onClick={() => void saveRename()} variant="accent" disabled={renameSaving || !nameDraft.trim()}>
                {renameSaving ? <Spinner size={12} /> : <Check size={12} />} Save
              </Chip>
              <TextButton onClick={() => setRenaming(false)} disabled={renameSaving}>
                <X size={11} /> Cancel
              </TextButton>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-ui text-[16px] font-semibold text-[color:var(--color-ink)]">
              {entity.name}
            </span>
            <TextButton icon={Pencil} ariaLabel="Rename" onClick={startRename} title="Rename" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            {KIND_LABEL[kind]}
          </span>
          {entity.aliases.map((a) => (
            <span key={a} className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">
              also: {a}
            </span>
          ))}
        </div>
      </div>

      {/* Field cards */}
      {person && (
        <>
          <FieldCard
            label="Role"
            field={person.role_provenance}
            defaultValue=""
            formatValue={(v) => v}
            onOpenMeeting={onOpenMeeting}
            onSave={(v) => saveField('role', v)}
            renderEditor={(v, onChange) => (
              <input
                autoFocus
                value={v}
                onChange={(e) => onChange(e.target.value)}
                className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
              />
            )}
          />
          <FieldCard
            label="Organization"
            field={person.org_provenance}
            defaultValue=""
            formatValue={(v) => v}
            onOpenMeeting={onOpenMeeting}
            onSave={(v) => saveField('org', v)}
            renderEditor={(v, onChange) => (
              <input
                autoFocus
                value={v}
                onChange={(e) => onChange(e.target.value)}
                className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
              />
            )}
          />
        </>
      )}

      {account && (
        <FieldCard
          label="Sector"
          field={account.sector_provenance}
          defaultValue={account.sector}
          formatValue={(v) => v.replace(/-/g, ' ')}
          onOpenMeeting={onOpenMeeting}
          onSave={(v) => saveField('sector', v)}
          renderEditor={(v, onChange) => (
            <select
              autoFocus
              value={v}
              onChange={(e) => onChange(e.target.value as (typeof SectorSchema.options)[number])}
              className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
            >
              {SectorSchema.options.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/-/g, ' ')}
                </option>
              ))}
            </select>
          )}
        />
      )}

      {deal && (
        <>
          <FieldCard
            label="Stage"
            field={deal.stage_provenance}
            defaultValue={deal.stage}
            formatValue={(v) => v}
            onOpenMeeting={onOpenMeeting}
            onSave={(v) => saveField('stage', v)}
            renderEditor={(v, onChange) => (
              <input
                autoFocus
                value={v}
                onChange={(e) => onChange(e.target.value)}
                className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
              />
            )}
          />
          <FieldCard
            label="Win likelihood"
            field={deal.win_likelihood_band_provenance}
            defaultValue={deal.win_likelihood_band}
            formatValue={(v: Band | null) => v ?? 'No read'}
            onOpenMeeting={onOpenMeeting}
            onSave={(v) => saveField('win_likelihood_band', v)}
            renderEditor={(v, onChange) => (
              <select
                autoFocus
                value={v ?? ''}
                onChange={(e) => onChange((e.target.value || null) as Band | null)}
                className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
              >
                <option value="">No read</option>
                {BandSchema.options.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
          />
          <FieldCard
            label="Velocity"
            field={deal.velocity_provenance}
            defaultValue={deal.velocity}
            formatValue={(v) => `${v.signal.replace(/-/g, ' ')}${v.evidence ? ` (${v.evidence})` : ''}`}
            onOpenMeeting={onOpenMeeting}
            onSave={(v) => saveField('velocity', v)}
            renderEditor={(v, onChange) => (
              <div className="flex flex-col gap-1.5">
                <select
                  autoFocus
                  value={v.signal}
                  onChange={(e) => onChange({ ...v, signal: e.target.value as typeof v.signal })}
                  className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
                >
                  <option value="hard-calendar-gate">hard calendar gate</option>
                  <option value="soft-organizational-gate">soft organizational gate</option>
                  <option value="no-hard-date-found">no hard date found</option>
                </select>
                <input
                  value={v.evidence}
                  onChange={(e) => onChange({ ...v, evidence: e.target.value })}
                  placeholder="Evidence"
                  className="no-drag focus-ring rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1 text-[13px] text-[color:var(--color-ink)]"
                />
              </div>
            )}
          />
          <MoneyCard deal={deal} onPin={(field, value) => saveField(field, value)} />
        </>
      )}

      {/* Same as… merge picker */}
      <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Same as…
          </span>
          {!mergeOpen && (
            <TextButton icon={Combine} onClick={() => setMergeOpen(true)}>
              Merge into another {KIND_LABEL[kind].toLowerCase()}
            </TextButton>
          )}
        </div>
        {mergeOpen && (
          <div className="flex flex-col gap-1.5">
            {!mergeTarget ? (
              <>
                <div className="flex items-center gap-1.5 rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2 py-1">
                  <Search size={12} className="text-[color:var(--color-ink-3)]" />
                  <input
                    autoFocus
                    value={mergeQuery}
                    onChange={(e) => setMergeQuery(e.target.value)}
                    placeholder={`Search ${KIND_LABEL[kind].toLowerCase()}s…`}
                    className="no-drag w-full bg-transparent text-[13px] text-[color:var(--color-ink)] focus:outline-none"
                  />
                </div>
                <div className="scroll-thin flex max-h-[160px] flex-col gap-0.5 overflow-y-auto">
                  {mergeCandidates.length === 0 ? (
                    <div className="px-1 py-1 text-[11px] text-[color:var(--color-ink-3)]">No matches.</div>
                  ) : (
                    mergeCandidates.slice(0, 30).map((cand) => (
                      <button
                        key={cand.id}
                        type="button"
                        onClick={() => setMergeTarget(cand)}
                        className="no-drag focus-ring flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-[12px] text-[color:var(--color-ink-2)] hover:bg-white/[0.06]"
                      >
                        <span className="min-w-0 truncate">{cand.name}</span>
                        <ChevronRight size={12} className="shrink-0" />
                      </button>
                    ))
                  )}
                </div>
                <TextButton onClick={() => setMergeOpen(false)}>Cancel</TextButton>
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="text-[12px] text-[color:var(--color-ink-2)]">
                  Merges <strong>{entity.name}</strong> into <strong>{mergeTarget.name}</strong>. Reversible via Undo.
                </div>
                {mergeError && <div className="text-[11px] text-[var(--color-danger)]">{mergeError}</div>}
                <div className="flex items-center gap-1">
                  <Chip onClick={() => void confirmMerge()} variant="accent" disabled={merging}>
                    {merging ? <Spinner size={12} /> : <Combine size={12} />} Confirm merge
                  </Chip>
                  <TextButton onClick={() => setMergeTarget(null)} disabled={merging}>
                    Back
                  </TextButton>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Open commitments */}
      {openCommitments.length > 0 && (
        <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Open commitments
          </div>
          <div className="flex flex-col gap-1">
            {openCommitments.map(({ c, dealName, dealId, personId }) => (
              <div key={c.meeting + c.text} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-[color:var(--color-ink-2)]" title={c.quote || undefined}>
                  {c.text}
                </span>
                {dealName && (
                  <>
                    <TextButton
                      ariaLabel="Mark kept"
                      title="Kept: promise delivered"
                      onClick={() => void settle(dealName, c.text, 'kept')}
                    >
                      <Check size={12} />
                    </TextButton>
                    <TextButton
                      ariaLabel="Mark broken"
                      title="Broken: promise not delivered"
                      onClick={() => void settle(dealName, c.text, 'broken')}
                    >
                      <X size={12} />
                    </TextButton>
                  </>
                )}
                {personId && (
                  <TextButton
                    title="Reject: this was misheard or never actually promised"
                    onClick={() => void reject(personId, dealId, c.text)}
                  >
                    Reject
                  </TextButton>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Meeting timeline */}
      {meetings.length > 0 && (
        <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            Meetings
          </div>
          <div className="flex flex-col gap-0.5">
            {meetings.map((m) => (
              <button
                key={m.file}
                type="button"
                onClick={() => onOpenMeeting?.(m.file)}
                disabled={!onOpenMeeting}
                className="no-drag focus-ring flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="shrink-0 text-[10px] text-[color:var(--color-ink-3)]">
                  {m.date ? new Date(m.date).toLocaleDateString() : ''}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--color-ink-2)]">
                  {m.title || m.file}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
