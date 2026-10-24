import { describe, expect, it } from 'vitest'
import type { TranscriptLine } from '@shared/transcript-line'
import { citeItem, supportsDue, supportsOwner } from './citations'

const line = (text: string, t: number, extra: Partial<TranscriptLine> = {}): TranscriptLine => ({
  speaker: 'them',
  text,
  t,
  ...extra
})

describe('citeItem', () => {
  const lines = [
    line('Good morning everyone, thanks for joining.', 1000),
    line('We will launch Project Lumen in the staged rollout next quarter.', 2000, { utteranceId: 'u2' }),
    line('Budget review is still pending.', 3000),
    line('Support readiness needs another pass.', 4000)
  ]

  it('cites the single line that states the decision', () => {
    expect(citeItem('Launch Project Lumen in a staged rollout', lines)).toEqual({
      fromLine: 1,
      toLine: 1,
      fromT: 2000,
      toT: 2000,
      utteranceIds: ['u2']
    })
  })

  it('spans up to three consecutive lines', () => {
    const split = [
      line('Alex will prepare the vendor contract', 10),
      line('and send the signed copy', 20),
      line('to legal before the audit window closes', 30)
    ]
    const c = citeItem('Prepare vendor contract, send signed copy to legal before audit window closes', split)
    expect(c).toMatchObject({ fromLine: 0, toLine: 2, fromT: 10, toT: 30 })
  })

  it('returns null below 0.5 overlap or under 2 shared tokens', () => {
    expect(citeItem('Migrate the billing database to the new cluster', lines)).toBeNull()
    expect(citeItem('Lumen', lines)).toBeNull()
  })

  it('folds accents and case (FR/PT)', () => {
    const fr = [line('On a décidé de reporter la réunion budgétaire', 5)]
    expect(citeItem('REPORTER la reunion budgetaire', fr)).toMatchObject({ fromLine: 0, toLine: 0 })
  })

  it('breaks ties by earliest window', () => {
    const twice = [line('Ship the pilot program soon', 1), line('Ship the pilot program soon', 2)]
    expect(citeItem('Ship pilot program', twice)).toMatchObject({ fromLine: 0, toLine: 0 })
  })

  it('empty lines → null', () => {
    expect(citeItem('Ship the pilot program', [])).toBeNull()
  })
})

describe('supportsOwner / supportsDue', () => {
  const lines = [
    line('Alex, can you take the contract?', 1, { speaker: 'you' }),
    line('Yes by Friday.', 2, { name: 'Sam' })
  ]
  const range = { fromLine: 0, toLine: 1, fromT: 1, toT: 2, utteranceIds: [] }
  it('accepts an owner named in the text or a line name', () => {
    expect(supportsOwner('alex', lines, range)).toBe(true)
    expect(supportsOwner('Sam', lines, range)).toBe(true)
  })
  it('rejects an owner the range does not mention', () => {
    expect(supportsOwner('Jordan', lines, range)).toBe(false)
  })
  it('requires every due token in the range', () => {
    expect(supportsDue('Friday', lines, range)).toBe(true)
    expect(supportsDue('next Friday', lines, range)).toBe(false)
  })
})
