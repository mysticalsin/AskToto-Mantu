import { useState } from 'react'

interface Props {
  entityKind: 'person' | 'account' | 'deal'
  entityId: string
  field: string
}

/**
 * Compact Accept affordance for one already-`extracted` provenance field (dashboard suggestion
 * accept/dismiss — deferred CRM pattern 3). Rendered by DealView/AccountsView/PeopleView's own Row
 * next to a field whose `field_state[field] === 'extracted'` (see brainAdapter.ts's fieldState()).
 *
 * Accept-only ON PURPOSE: the host's correction engine (src/main/brain/corrections.ts) has no mutation
 * that clears/reverts a field's value, only ones that pin a NEW one — so "dismiss" has no legal
 * expression there (see the brain:field-decision handler's doc comment in main/index.ts) and isn't
 * offered here either, rather than shipping a button that would always fail.
 *
 * On success the correction-engine's markBrainChanged bump reaches this view on the next
 * useDashboardData revision poll (~2s) — no local data mutation here; the field simply drops out of
 * `field_state` once the reload lands, and this button disappears with it.
 */
export function AcceptSuggestion({ entityKind, entityId, field }: Props) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle')

  async function accept() {
    if (!window.intelligence) return
    setStatus('pending')
    try {
      const r = await window.intelligence.fieldDecision({ entityKind, entityId, field, decision: 'accept' })
      setStatus(r.ok ? 'idle' : 'error')
    } catch {
      setStatus('error')
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={accept}
        disabled={status === 'pending'}
        title="Extracted from a meeting, not yet reviewed — accept to confirm it."
        className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
      >
        {status === 'pending' ? '…' : 'Accept'}
      </button>
      {status === 'error' && <span className="text-[9px] text-rose-300">failed</span>}
    </span>
  )
}
