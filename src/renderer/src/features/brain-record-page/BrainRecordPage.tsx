import { useMemo, useState } from 'react'
import { Check, ChevronRight, Combine, Pencil, Search, Undo2, X } from 'lucide-react'
import type { AccountEntity, Band, BrainRead, DealEntity, EntityKind, LedgerCommitment, PersonEntity } from '@shared/brain'
import { BandSchema, SectorSchema } from '@shared/brain'
import { Chip, TextButton } from '../../components/ui'
import { InlineOrb } from '../../components/AgentStatus'
import {
  FieldCard,
  KIND_LABEL,
  MoneyCard,
  filterMergeCandidates,
  isMeaningfulRename,
  mergeBannerApplies,
  type BrainRecordRef,
  type RecentMerge
} from './record-support'

export {
  filterMergeCandidates,
  formatAmount,
  isMeaningfulRename,
  mergeBannerApplies,
  moneyFieldMode,
  provenanceChipLabel,
  recordKey,
  sortAttentionItems,
  type BrainRecordRef,
  type MoneyFieldMode,
  type RecentMerge
} from './record-support'

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
        onMerged({ seq: r.seq, kind, fromId: id, fromLabel: entity.name, intoId: target.id, intoLabel: target.name })
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
      {recentMerge && mergeBannerApplies(recentMerge, recordRef) && (
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
                {renameSaving ? <InlineOrb kind="loading" /> : <Check size={12} />} Save
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
                    {merging ? <InlineOrb kind="loading" /> : <Combine size={12} />} Confirm merge
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
