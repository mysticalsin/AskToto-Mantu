import type { Settings } from '@shared/ipc'
import type { AttentionItem } from '@shared/ipc'
import type { ProvenantField } from '@shared/brain'
import { mapWithConcurrency } from '../infra/concurrency'
import { loadAccount, loadDeal, loadEntitySlugs, loadPerson, readIndexAsync } from './store'
import { ingestFailureDetails } from './ingest'
import { lintDeal, lintPerson } from './lint'

/**
 * Needs-attention aggregation (Task MI-3) — the signal classes BrainView's Attention section surfaces,
 * none of them ever auto-resolved:
 *   - 'lint': a lintBrain contradiction (lintBrainDetailed — the same checks that feed idx.warnings,
 *     here kept entity-linked so the UI can jump straight to the record page).
 *   - 'ambiguous': a provenant field the extractor itself flagged AMBIGUOUS (low-confidence guess).
 *   - 'contradicted_pin': a human pinned/edited a field, then a LATER meeting reported something
 *     different — mergeProvenant refuses to overwrite a pin, but still records the newer value into
 *     `superseded` (see shared/brain.ts's ProvenantField doc comment), so it's detectable here without
 *     ever silently resolving it either way.
 *   - 'ingest_failed': a source file that durably failed extraction (idx.ingested[file].ok === false).
 *     Not entity-linked (no record exists to jump to) — the renderer opens the transcript instead.
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

/** Loads every entity of one kind through the storage gateway: a cloud-only or stuck file is classified and
 *  skipped (loaders answer null), never opened on the main thread; at most 16 reads are in flight. */
async function loadAll<T>(
  s: Settings,
  kind: 'person' | 'account' | 'deal',
  load: (s: Settings, slug: string) => Promise<T | null>
): Promise<Array<{ slug: string; entity: T }>> {
  const slugs = await loadEntitySlugs(s, kind)
  const loaded = await mapWithConcurrency(slugs, 16, async (slug) => ({ slug, entity: await load(s, slug) }))
  return loaded.flatMap((row) => (row?.entity ? [{ slug: row.slug, entity: row.entity }] : []))
}

export async function computeAttention(s: Settings): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []
  const [people, accounts, deals] = await Promise.all([
    loadAll(s, 'person', loadPerson),
    loadAll(s, 'account', loadAccount),
    loadAll(s, 'deal', loadDeal)
  ])

  const lint = [
    ...people.flatMap((p) => lintPerson(p.slug, p.entity)),
    ...deals.flatMap((d) => lintDeal(d.slug, d.entity))
  ]
  for (const f of lint) {
    items.push({ kind: 'lint', entityKind: f.entityKind, id: f.id, label: f.label, detail: f.detail })
  }

  for (const { slug, entity: p } of people) {
    items.push(...fieldItems('person', slug, p.name, 'Role', p.role_provenance, (v) => v))
    items.push(...fieldItems('person', slug, p.name, 'Organization', p.org_provenance, (v) => v))
  }
  for (const { slug, entity: a } of accounts) {
    items.push(...fieldItems('account', slug, a.name, 'Sector', a.sector_provenance, (v) => v))
  }
  for (const { slug, entity: d } of deals) {
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

  // Durably failed sources — capped at 10 (this feed is a glance list, not the full ledger; the exact
  // per-file detail lives in brain:status's failedDetails for the dashboard's own failure banner). No
  // entityKind: there is no record to jump to, so `id` carries the filename and the renderer opens the
  // transcript instead.
  for (const f of ingestFailureDetails(await readIndexAsync(s), 10)) {
    items.push({
      kind: 'ingest_failed',
      id: f.file,
      label: f.file,
      detail: f.exhausted ? `Exhausted after repeated retries: ${f.error}` : `Failed to index: ${f.error}`
    })
  }

  return items
}
