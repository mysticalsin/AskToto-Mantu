import { describe, it, expect } from 'vitest'
import { Lru } from './recall-io'

describe('Lru', () => {
  it('evicts only the least recently used entry when full', () => {
    const cache = new Lru<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.get('a') // a is now the freshest, b the oldest
    cache.set('d', 4)
    expect(cache.size).toBe(3)
    expect(cache.get('b')).toBeUndefined()
    expect([cache.get('a'), cache.get('c'), cache.get('d')]).toEqual([1, 3, 4])
  })

  it('overwriting a key does not grow the cache', () => {
    const cache = new Lru<number>(2)
    cache.set('a', 1)
    cache.set('a', 2)
    cache.set('b', 3)
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBe(2)
  })
})
