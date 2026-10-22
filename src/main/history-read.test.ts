import { describe, expect, it } from 'vitest'
import { ByteBudgetCache } from './history-read-cache'
import { RECALL_SEARCH_MAX_CHARS, RECALL_SEARCH_MAX_TERMS } from '@shared/recall-search'
import { compareMeetingRowsNewestFirst, isTransientProjectionError, parseSearchTerms } from './history-read'

describe('History date ordering', () => {
  it('keeps the same newest-first order as the previous localeCompare comparator', () => {
    const rows = [
      { date: '2026-10-02T10:00:00.000Z' },
      { date: '' },
      { date: '2026-10-02T09:00:00.000Z' },
      { date: '2026-09-30T23:59:59.000Z' },
      { date: '2026-10-02' }
    ]
    const previous = rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    const next = rows.slice().sort(compareMeetingRowsNewestFirst)
    expect(next).toEqual(previous)
  })
})

describe('History search query limits', () => {
  it('search caps terms at 16 and reports total', () => {
    const words = Array.from({ length: 40 }, (_, i) => `term${String(i).padStart(2, '0')}`)
    const terms = parseSearchTerms(words.join(' '))
    expect(RECALL_SEARCH_MAX_TERMS).toBe(16)
    expect(terms).toEqual(words.slice(0, 16))
  })

  it('cuts the query at 200 characters before splitting it', () => {
    expect(RECALL_SEARCH_MAX_CHARS).toBe(200)
    const query = `${'a'.repeat(198)} tail needle`
    expect(parseSearchTerms(query)).toEqual(['a'.repeat(198)])
  })

  it('lowercases, drops one-character terms and treats an empty query as no terms', () => {
    expect(parseSearchTerms('  Pilot  X  MARCH ')).toEqual(['pilot', 'march'])
    expect(parseSearchTerms('   ')).toEqual([])
    expect(parseSearchTerms('')).toEqual([])
  })
})

describe('History read cache budget', () => {
  it('read cache evicts by byte budget', () => {
    const cache = new ByteBudgetCache<string>(100, 10)
    cache.set('a', 'A', 4)
    cache.set('b', 'B', 4)
    cache.set('c', 'C', 4)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.bytes).toBe(8)
    cache.get('b') // touched: now warmer than c
    cache.set('d', 'D', 4)
    expect(cache.get('c')).toBeUndefined()
    expect(cache.get('b')).toBe('B')
    expect(cache.get('d')).toBe('D')
    expect(cache.bytes).toBe(8)
  })

  it('still bounds the entry count, and replaces an entry without double counting its bytes', () => {
    const cache = new ByteBudgetCache<number>(2, 1000)
    cache.set('a', 1, 10)
    cache.set('b', 2, 10)
    cache.set('c', 3, 10)
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    cache.set('b', 4, 5)
    expect(cache.bytes).toBe(15)
  })

  it('does not keep one entry larger than the whole budget, and drops the older value under that key', () => {
    const cache = new ByteBudgetCache<string>(100, 10)
    cache.set('a', 'small', 4)
    cache.set('big', 'BIG', 11)
    expect(cache.get('big')).toBeUndefined()
    expect(cache.get('a')).toBe('small')
    cache.set('a', 'now-big', 11)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.bytes).toBe(0)
  })
})

describe('History projection errors', () => {
  it('treats only a resource-limit refusal as transient', () => {
    expect(isTransientProjectionError(Object.assign(new Error('x'), { name: 'RESOURCE_LIMIT' }))).toBe(true)
    expect(isTransientProjectionError(new Error('Meeting text could not be projected safely.'))).toBe(false)
    expect(isTransientProjectionError('RESOURCE_LIMIT')).toBe(false)
  })
})
