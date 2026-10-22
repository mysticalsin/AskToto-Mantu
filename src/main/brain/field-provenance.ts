import { isDeepStrictEqual } from 'node:util'
import type { Settings } from '@shared/ipc'
import type { EntityKind, ProvenantField } from '@shared/brain'
import { readAccount, readDeal, readPerson, slugify } from './store'

export const VALUE_CHANGED_ERROR = 'This value changed. Review it again.'

/** Read-only counterpart to applyFieldUpdate (corrections.ts) — looks up the CURRENT provenance for one
 *  (kind, id, field) without writing anything. Mirrors applyFieldUpdate's exact (kind, field) support
 *  set field-for-field, so a field this doesn't recognize is one updateEntityField wouldn't accept
 *  either. Returns undefined for an unknown entity/field, never throws.
 *
 *  Used by the dashboard's accept-suggestion action (main/index.ts's brain:field-decision handler) to
 *  confirm a field is genuinely `state: 'extracted'` before calling updateEntityField with the field's
 *  OWN unchanged value — the only correction-engine mutation this task found a legal expression for
 *  (see updateEntityField's doc comment: it always pins to `state: 'pinned'`, never `'verified'`, and
 *  there is no field_update variant that clears/reverts a value, so "dismiss" has no expression here). */
export function readFieldProvenance(
  s: Settings,
  payload: { kind: EntityKind; id: string; field: string }
): ProvenantField<unknown> | undefined {
  const id = slugify(payload.id)
  if (payload.kind === 'person') {
    const person = readPerson(s, id)
    if (!person) return undefined
    if (payload.field === 'role') return person.role_provenance
    if (payload.field === 'org') return person.org_provenance
    return undefined
  }
  if (payload.kind === 'account') {
    const account = readAccount(s, id)
    if (!account) return undefined
    if (payload.field === 'sector') return account.sector_provenance
    return undefined
  }
  const deal = readDeal(s, id)
  if (!deal) return undefined
  if (payload.field === 'stage') return deal.stage_provenance
  if (payload.field === 'win_likelihood_band') return deal.win_likelihood_band_provenance
  if (payload.field === 'velocity') return deal.velocity_provenance
  if (payload.field === 'amount') return deal.amount
  if (payload.field === 'close_date') return deal.close_date
  return undefined
}

/** True when an Accept must be refused: the field is no longer pending review, or it no longer holds the value
 *  the person looked at. Called inside the entity lock, so nothing can change it between this check and the pin. */
export function acceptIsStale(
  s: Settings,
  payload: { kind: EntityKind; id: string; field: string },
  expectedValue: unknown
): boolean {
  const current = readFieldProvenance(s, payload)
  return !current || current.state !== 'extracted' || !isDeepStrictEqual(current.value, expectedValue)
}
