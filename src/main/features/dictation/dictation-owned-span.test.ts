import { describe, expect, it } from 'vitest'
import { createOwnedSpanLedger, isOwnedSpan, mintOwnedSpan } from './dictation-owned-span'

describe('owned spans (G26)', () => {
  it('a minted span is recognised; a copy, a literal and a primitive are not', () => {
    const span = mintOwnedSpan('dictated words', 'dictation-turn')
    expect(isOwnedSpan(span)).toBe(true)
    expect(span.text).toBe('dictated words')
    expect(isOwnedSpan({ ...span })).toBe(false)
    expect(isOwnedSpan({ text: 'dictated words', origin: 'dictation-turn' })).toBe(false)
    expect(isOwnedSpan('dictated words')).toBe(false)
    expect(isOwnedSpan(null)).toBe(false)
    expect(Object.isFrozen(span)).toBe(true)
  })

  it('the ledger holds an inserted span for twenty seconds (PROVIDED by the spec) and hands it out once', () => {
    const clock = { value: 1_000 }
    let n = 0
    const ledger = createOwnedSpanLedger({ now: () => clock.value, newId: () => (++n).toString(16).padStart(32, '0') })
    const id = ledger.mint('inserted words')!
    expect(ledger.recent()).toEqual([{ id, text: 'inserted words', insertedAtMs: 1_000, expiresAtMs: 21_000 }])
    clock.value += 19_999
    const claimed = ledger.claim(id)
    expect(claimed && isOwnedSpan(claimed)).toBe(true)
    expect(ledger.claim(id)).toBeNull()
    expect(ledger.recent()).toEqual([])
  })

  it('an expired span can no longer be corrected and is dropped from the list', () => {
    const clock = { value: 1_000 }
    const ledger = createOwnedSpanLedger({ now: () => clock.value })
    const id = ledger.mint('inserted words')!
    clock.value += 20_001
    expect(ledger.recent()).toEqual([])
    expect(ledger.claim(id)).toBeNull()
  })

  it('is bounded to eight spans, newest first, and clear forgets all of them', () => {
    const clock = { value: 1_000 }
    const ledger = createOwnedSpanLedger({ now: () => clock.value })
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      clock.value += 1
      ids.push(ledger.mint(`words ${i}`)!)
    }
    const recent = ledger.recent()
    expect(recent).toHaveLength(8)
    expect(recent[0].text).toBe('words 9')
    expect(ledger.claim(ids[0])).toBeNull()
    ledger.clear()
    expect(ledger.recent()).toEqual([])
  })

  it('ignores blank text and an unknown id', () => {
    const ledger = createOwnedSpanLedger({ now: () => 1 })
    expect(ledger.mint('   ')).toBeNull()
    expect(ledger.claim('0'.repeat(32))).toBeNull()
    expect(ledger.claim('bad')).toBeNull()
  })
})
