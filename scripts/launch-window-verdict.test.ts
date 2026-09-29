import { describe, expect, it } from 'vitest'
import { launchVerdict } from './launch-window-verdict.mjs'

type Verdict = ReturnType<typeof launchVerdict>

/** Feed the gate's polling loop one title sample per poll, as it would see them, until a terminal verdict. */
function replay(samples: string[][], opts: { exitedAfter?: number; deadlineAfter?: number } = {}): Verdict {
  let verdict: Verdict = 'pending'
  for (let i = 0; i < samples.length && verdict === 'pending'; i++) {
    verdict = launchVerdict({
      titles: samples[i],
      exited: opts.exitedAfter !== undefined && i >= opts.exitedAfter,
      deadlinePassed: opts.deadlineAfter !== undefined && i >= opts.deadlineAfter
    })
  }
  return verdict
}

describe('M2-0420 packaged launch verdict', () => {
  it('keeps polling through the package-name title and accepts the product title once it appears', () => {
    expect(launchVerdict({ titles: ['asktoto'], exited: null, deadlinePassed: false })).toBe('pending')
    expect(replay([['asktoto'], ['Métis']])).toBe('healthy')
  })

  it('accepts a product-titled window on the first sample', () => {
    expect(replay([['Métis']])).toBe('healthy')
    expect(replay([['Metis']])).toBe('healthy')
  })

  it('fails on a real Error dialog', () => {
    expect(replay([['Error']])).toBe('error-dialog')
    expect(replay([['asktoto'], ['Error']])).toBe('error-dialog')
  })

  it('does not treat the product window text as an error dialog', () => {
    expect(replay([['asktoto'], ['asktoto'], ['Métis']])).not.toBe('error-dialog')
  })

  it('fails when no window ever appears before the deadline', () => {
    expect(replay([[], [], []], { deadlineAfter: 2 })).toBe('timeout')
  })

  it('fails when only the package-name title is ever seen before the deadline', () => {
    expect(replay([['asktoto'], ['asktoto']], { deadlineAfter: 1 })).toBe('timeout')
  })

  it('stops when the process exits without a product window', () => {
    expect(replay([[], ['asktoto']], { exitedAfter: 1 })).toBe('exited')
  })
})
