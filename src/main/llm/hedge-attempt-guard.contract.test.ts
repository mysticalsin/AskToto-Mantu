import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

/**
 * D5-3: a hedge loser's backoff timer survives the winner and re-enters attempt(), which dispatched a fresh
 * provider request (and wrote a provider.request audit line, and could set a failover chip) for an ask that
 * was already answered. attempt() must refuse before doing any work.
 */
describe('askStart attempt() hedge-loser guard (D5-3)', () => {
  const { text } = readModuleSource(__dirname, '../index')
  const source = text.replace(/\r\n/g, '\n')

  it('returns first thing when this leg already lost', () => {
    const start = source.indexOf('const attempt = (')
    expect(start).toBeGreaterThan(0)
    const afterSignature = source.slice(source.indexOf('): void => {', start) + '): void => {'.length)
    const firstCode = afterSignature
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('//'))
    expect(firstCode).toMatch(/^if \(race && race\.gate\.isLoser\(race\.leg\)\) return\b/)
  })

  it('still routes the retry timer back through attempt()', () => {
    expect(source).toMatch(/setTimeout\(\(\) => attempt\(provider, attempted, retryCount \+ 1, race\), delayMs\)/)
  })
})
