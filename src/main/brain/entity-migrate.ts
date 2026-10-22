import type { AccountEntity, Confidence, DealEntity, PersonEntity, ProvenantField } from '@shared/brain'

// ── v1 → v2 lazy migration (B2) ──────────────────────────────────────────────
//
// A v1 entity file has role/org/sector/stage/win_likelihood_band/velocity as plain values with zero
// per-field provenance. Rather than replacing those fields in place (see the ProvenantField doc comment
// in shared/brain.ts for why that would break buildBrainContext/mars.ts/BrainView.tsx), v2 keeps them
// exactly as they are and adds a `<field>_provenance` sidecar the first time each file is read. The
// sidecar is synthesized HONESTLY, never fabricated:
//   - source_file: '' — we genuinely don't know which meeting first asserted the value; inventing one
//     would be a fabricated citation, so it stays empty (an honest "unknown" sentinel).
//   - date: the entity's EARLIEST known meeting date — the best available lower bound for when this
//     value could first have been true — or '' if the entity has no dated meetings at all.
//   - confidence: reuses the field's own REAL historical confidence where one already existed on disk
//     (AccountEntity.sector_confidence); everything else (role/org/stage/band/velocity) never had a
//     per-field confidence in v1, so it gets 'INFERRED' — honest because we cannot claim EXTRACTED-grade
//     provenance for a value that was never tagged as such.
//   - state: 'extracted' — the normal merge/date-gate rules apply to it going forward.
// Migration never fires for a field whose plain value is absent (null/''/the bland velocity default) —
// there is nothing to attach honest provenance to.

function earliestDate(meetings: Array<{ date: string }>): string {
  const dates = meetings
    .map((m) => m.date)
    .filter(Boolean)
    .sort()
  return dates[0] ?? ''
}

function migrateField<T>(
  value: T,
  meetings: Array<{ date: string }>,
  confidence: Confidence = 'INFERRED',
  quote?: string
): ProvenantField<T> {
  return { value, source_file: '', date: earliestDate(meetings), quote, confidence, state: 'extracted', superseded: [] }
}

export function migratePerson(p: PersonEntity, slug: string): PersonEntity {
  p.id = p.id || slug
  p.aliases ??= []
  if (!p.role_provenance && p.role) p.role_provenance = migrateField(p.role, p.meetings)
  if (!p.org_provenance && p.account) p.org_provenance = migrateField(p.account, p.meetings)
  return p
}

export function migrateAccount(a: AccountEntity, slug: string): AccountEntity {
  a.id = a.id || slug
  a.aliases ??= []
  if (!a.sector_provenance) a.sector_provenance = migrateField(a.sector, a.meetings, a.sector_confidence)
  return a
}

export function migrateDeal(d: DealEntity, slug: string): DealEntity {
  d.id = d.id || slug
  d.aliases ??= []
  if (!d.stage_provenance && d.stage) d.stage_provenance = migrateField(d.stage, d.meetings)
  if (!d.win_likelihood_band_provenance && d.win_likelihood_band) {
    d.win_likelihood_band_provenance = migrateField(
      d.win_likelihood_band,
      d.meetings,
      'INFERRED',
      d.band_evidence || undefined
    )
  }
  if (!d.velocity_provenance && d.velocity.signal !== 'no-hard-date-found') {
    d.velocity_provenance = migrateField(d.velocity, d.meetings)
  }
  return d
}
