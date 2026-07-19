import { describe, it, expect } from 'vitest'
import {
  provenanceChipLabel,
  moneyFieldMode,
  sortAttentionItems,
  filterMergeCandidates,
  formatAmount,
  isMeaningfulRename,
  recordKey
} from './BrainRecordPage'
import type { AttentionItem } from '@shared/ipc'

function field(state: 'extracted' | 'verified' | 'edited' | 'pinned', quote?: string, source_file = 'meeting.md') {
  return { state, quote, source_file }
}

describe('provenanceChipLabel', () => {
  it('returns empty string for an absent field', () => {
    expect(provenanceChipLabel(undefined)).toBe('')
  })

  it('extracted with a quote cites the quote and the source meeting', () => {
    expect(provenanceChipLabel(field('extracted', 'we need this by Q3', 'call-1.md'))).toBe(
      'extracted: "we need this by Q3" (call-1.md)'
    )
  })

  it('extracted with no quote still cites the source meeting', () => {
    expect(provenanceChipLabel(field('extracted', undefined, 'call-1.md'))).toBe('extracted (call-1.md)')
  })

  it('extracted with no source_file falls back to "unknown meeting"', () => {
    expect(provenanceChipLabel(field('extracted', undefined, ''))).toBe('extracted (unknown meeting)')
  })

  it('verified state renders as "verified"', () => {
    expect(provenanceChipLabel(field('verified'))).toBe('verified')
  })

  it('pinned state renders as "edited by you"', () => {
    expect(provenanceChipLabel(field('pinned'))).toBe('edited by you')
  })

  it('edited state renders as "edited by you"', () => {
    expect(provenanceChipLabel(field('edited'))).toBe('edited by you')
  })
})

describe('moneyFieldMode — the money-card invariant: the unverified case must NEVER yield a numeric string', () => {
  const fmt = (v: { value: number; currency: string }): string => `${v.value} ${v.currency}`

  it('absent field renders "Not stated" with no digits', () => {
    const mode = moneyFieldMode(undefined, fmt)
    expect(mode.kind).toBe('absent')
    expect(mode.text).toBe('Not stated')
    expect(mode.text).not.toMatch(/\d/)
  })

  it('extracted (unverified) field renders the pin-to-confirm message, never the raw number', () => {
    const mode = moneyFieldMode({ state: 'extracted', value: { value: 250_000, currency: 'EUR' } }, fmt)
    expect(mode.kind).toBe('unverified')
    expect(mode.text).toBe('Stated but unverified, pin to confirm')
    expect(mode.text).not.toMatch(/\d/)
    expect(mode.text).not.toContain('250')
  })

  it('verified field renders the formatted value', () => {
    const mode = moneyFieldMode({ state: 'verified', value: { value: 250_000, currency: 'EUR' } }, fmt)
    expect(mode.kind).toBe('verified')
    expect(mode.text).toBe('250000 EUR')
  })

  it('pinned field renders the formatted value (a human pin is trusted)', () => {
    const mode = moneyFieldMode({ state: 'pinned', value: { value: 100, currency: 'USD' } }, fmt)
    expect(mode.kind).toBe('verified')
    expect(mode.text).toBe('100 USD')
  })

  it('edited field renders the formatted value', () => {
    const mode = moneyFieldMode({ state: 'edited', value: { value: 1, currency: 'GBP' } }, fmt)
    expect(mode.kind).toBe('verified')
    expect(mode.text).toBe('1 GBP')
  })
})

describe('formatAmount', () => {
  it('formats a value + currency with thousands separators', () => {
    expect(formatAmount({ value: 250000, currency: 'EUR' })).toBe('250,000 EUR')
  })
})

describe('sortAttentionItems — most urgent (contradicted pins) first', () => {
  const item = (kind: AttentionItem['kind'], id: string): AttentionItem => ({
    kind,
    entityKind: 'deal',
    id,
    label: id,
    detail: ''
  })

  it('orders contradicted_pin before ambiguous before lint', () => {
    const items = [item('lint', 'a'), item('ambiguous', 'b'), item('contradicted_pin', 'c')]
    expect(sortAttentionItems(items).map((i) => i.kind)).toEqual(['contradicted_pin', 'ambiguous', 'lint'])
  })

  it('is stable within the same kind', () => {
    const items = [item('lint', 'a'), item('lint', 'b'), item('lint', 'c')]
    expect(sortAttentionItems(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const items = [item('lint', 'a'), item('contradicted_pin', 'b')]
    const copy = [...items]
    sortAttentionItems(items)
    expect(items).toEqual(copy)
  })
})

describe('filterMergeCandidates — the "Same as…" picker list', () => {
  const entities = [
    { id: 'acme', name: 'Acme' },
    { id: 'acme-corp', name: 'Acme Corp' },
    { id: 'globex', name: 'Globex' }
  ]

  it('excludes the current record itself', () => {
    const result = filterMergeCandidates(entities, 'acme', '')
    expect(result.map((e) => e.id)).toEqual(['acme-corp', 'globex'])
  })

  it('filters by a case-insensitive name match', () => {
    const result = filterMergeCandidates(entities, 'acme', 'glo')
    expect(result.map((e) => e.id)).toEqual(['globex'])
  })

  it('an empty query returns every other entity', () => {
    const result = filterMergeCandidates(entities, 'globex', '   ')
    expect(result.map((e) => e.id)).toEqual(['acme', 'acme-corp'])
  })

  it('a query matching nothing returns an empty list', () => {
    expect(filterMergeCandidates(entities, 'acme', 'zzz')).toEqual([])
  })
})

describe('isMeaningfulRename — gates the "also fix live transcription" checkbox', () => {
  it('a genuine surface-form change is meaningful', () => {
    expect(isMeaningfulRename('Acme Corp', 'Acme')).toBe(true)
    expect(isMeaningfulRename('M Silva', 'Maria Silva')).toBe(true)
  })

  it('casing-only and diacritic-only changes are NOT meaningful (ASR never hears those)', () => {
    expect(isMeaningfulRename('acme corp', 'Acme Corp')).toBe(false)
    expect(isMeaningfulRename("L'Oreal", "L'Oréal")).toBe(false)
  })

  it('an unchanged or blank new name is not meaningful', () => {
    expect(isMeaningfulRename('Acme', 'Acme')).toBe(false)
    expect(isMeaningfulRename('Acme', '  ')).toBe(false)
  })
})

describe('recordKey — the React key that forces a fresh remount on every record change', () => {
  // BrainView stamps this as <BrainRecordPage key={recordKey(record)} />. React only remounts (clearing
  // every in-progress FieldCard/rename draft) when the key CHANGES, so the property that matters is:
  // a different record ⇒ a different key. The exact failure the reviewer flagged is the direct
  // record→record transition (post-merge navigate-to-survivor, post-undo navigate-to-restored-source):
  // same component element, different record — its key must differ so a half-typed edit can't save to
  // the wrong entity.

  it('a post-merge navigation to the survivor yields a different key (so the page remounts)', () => {
    // The exact shape of confirmMerge → onOpenRecord(kind, survivorId): same kind, different id.
    expect(recordKey({ kind: 'account', id: 'acme' })).not.toBe(recordKey({ kind: 'account', id: 'acme-holdings' }))
  })

  it('a post-undo navigation back to the restored source yields a different key', () => {
    // undoMerge → setRecord({ kind, id: fromId }) after having landed on the survivor.
    const survivor = recordKey({ kind: 'person', id: 'maria-silva' })
    const restoredSource = recordKey({ kind: 'person', id: 'm-silva' })
    expect(restoredSource).not.toBe(survivor)
  })

  it('differs when only the kind differs (two entities can share a slug across kinds)', () => {
    expect(recordKey({ kind: 'account', id: 'acme' })).not.toBe(recordKey({ kind: 'deal', id: 'acme' }))
  })

  it('is stable for the same record (no gratuitous remount while editing the SAME entity)', () => {
    expect(recordKey({ kind: 'deal', id: 'acme-core' })).toBe(recordKey({ kind: 'deal', id: 'acme-core' }))
  })
})
