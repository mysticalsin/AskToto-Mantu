import type { Settings } from '@shared/ipc'
import type { AttentionItem } from '@shared/ipc'
import type { ProvenantField } from '@shared/brain'
import { listEntities, readPerson, readAccount, readDeal } from './store'
import { lintBrainDetailed } from './ingest'

/**
 * Needs-attention aggregation (Task MI-3) — the three signal classes BrainView's Attention section
 * surfaces, none of them ever auto-resolved:
 *   - 'lint': a lintBrain contradiction (lintBrainDetailed — the same checks that feed idx.warnings,
 *     here kept entity-linked so the UI can jump straight to the record page).
 *   - 'ambiguous': a provenant field the extractor itself flagged AMBIGUOUS (low-confidence guess).
 *   - 'contradicted_pin': a human pinned/edited a field, then a LATER meeting reported something
 *     different — mergeProvenant refuses to overwrite a pin, but still records the newer value into
 *     `superseded` (see shared/brain.ts's ProvenantField doc comment), so it's detectable here without
 *     ever silently resolving it either way.
 * Read-only; never mutates the store.
 *
 * MI-4 review fix (numeric leak): `describe` is EITHER a formatter (text fields — role/org/sector/
 * stage/win-likelihood/velocity, safe to show verbatim so the user can tell what's wrong) OR the
 * literal `'redact'` sentinel for numeric/money fields (deal amount, close_date). Passing `'redact'`
 * means `describe` is never invoked and the raw value can never reach `detail` — BrainView renders
 * `item.detail` verbatim (no gate downstream), so this is the ONLY place that decides whether a number
 * is fit to render, and an AMBIGUOUS or superseded-but-unverified figure never is. This mirrors the
 * render-gate invariant in shared/brain.ts's RENDERABLE_PROVENANCE_STATES (verified/pinned/edited only)
 * but for the ATTENTION surface specifically: even a pinned amount's `detail` never repeats a
 * *contradicting* value, because that superseded candidate was never itself verified.
 */
function fieldItems<T>(
  entityKind: 'person' | 'account' | 'deal',
  id: string,
  entityLabel: string,
  fieldName: string,
  field: ProvenantField<T> | undefined,
  describe: ((v: T) => string) | 'redact'
): AttentionItem[] {
  if (!field) return []
  const items: AttentionItem[] = []
  if (field.confidence === 'AMBIGUOUS') {
    items.push({
      kind: 'ambiguous',
      entityKind,
      id,
      label: entityLabel,
      detail:
        describe === 'redact'
          ? `${fieldName} is unconfirmed — open the record to verify.`
          : `${fieldName}: "${describe(field.value)}" is unconfirmed (AMBIGUOUS)`
    })
  }
  if (field.state === 'pinned' || field.state === 'edited') {
    // Most recent contradicting sighting wins the detail text — the one worth showing first.
    const newer = [...field.superseded].filter((e) => e.date > field.date).sort((a, b) => (a.date > b.date ? -1 : 1))[0]
    if (newer) {
      items.push({
        kind: 'contradicted_pin',
        entityKind,
        id,
        label: entityLabel,
        detail:
          describe === 'redact'
            ? `A later meeting reported a different ${fieldName.toLowerCase()} than your pinned value — review the record.`
            : `${fieldName} was pinned to "${describe(field.value)}", but a later meeting (${newer.date}) reported "${describe(newer.value)}"`
      })
    }
  }
  return items
}

export function computeAttention(s: Settings): AttentionItem[] {
  const items: AttentionItem[] = []

  for (const f of lintBrainDetailed(s)) {
    items.push({ kind: 'lint', entityKind: f.entityKind, id: f.id, label: f.label, detail: f.detail })
  }

  for (const slug of listEntities(s, 'person')) {
    const p = readPerson(s, slug)
    if (!p) continue
    items.push(...fieldItems('person', slug, p.name, 'Role', p.role_provenance, (v) => v))
    items.push(...fieldItems('person', slug, p.name, 'Organization', p.org_provenance, (v) => v))
  }
  for (const slug of listEntities(s, 'account')) {
    const a = readAccount(s, slug)
    if (!a) continue
    items.push(...fieldItems('account', slug, a.name, 'Sector', a.sector_provenance, (v) => v))
  }
  for (const slug of listEntities(s, 'deal')) {
    const d = readDeal(s, slug)
    if (!d) continue
    items.push(...fieldItems('deal', slug, d.name, 'Stage', d.stage_provenance, (v) => v))
    items.push(
      ...fieldItems('deal', slug, d.name, 'Win likelihood', d.win_likelihood_band_provenance, (v) => v ?? 'no read')
    )
    items.push(...fieldItems('deal', slug, d.name, 'Velocity', d.velocity_provenance, (v) => v.signal))
    // Amount/close_date are numeric/money fields — MI-4 review fix: NEVER pass a formatter here. The
    // 'redact' sentinel is structural: it makes leaking the raw figure into `detail` a compile-time
    // impossibility for these two fields, rather than relying on every caller remembering not to.
    items.push(...fieldItems('deal', slug, d.name, 'Amount', d.amount, 'redact'))
    items.push(...fieldItems('deal', slug, d.name, 'Close date', d.close_date, 'redact'))
  }

  return items
}
