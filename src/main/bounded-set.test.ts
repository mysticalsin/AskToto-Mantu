import { describe, expect, it } from 'vitest'
import { BoundedSet } from './bounded-set'

describe('BoundedSet', () => {
  it('never grows past max and evicts the oldest first', () => {
    const s = new BoundedSet<string>(3)
    s.add('a').add('b').add('c')
    expect(s.size).toBe(3)
    s.add('d')
    expect(s.size).toBe(3)
    expect(s.has('a')).toBe(false)
    expect(s.has('b')).toBe(true)
    expect(s.has('d')).toBe(true)
  })

  it('re-adding an existing key is a no-op and does not reorder eviction', () => {
    const s = new BoundedSet<string>(2)
    s.add('a').add('b')
    s.add('a')
    s.add('c')
    expect(s.has('a')).toBe(false)
    expect(s.has('b')).toBe(true)
    expect(s.has('c')).toBe(true)
  })

  it('stays bounded over a long session', () => {
    const s = new BoundedSet<number>(100)
    for (let i = 0; i < 50_000; i++) s.add(i)
    expect(s.size).toBe(100)
    expect(s.has(49_999)).toBe(true)
    expect(s.has(0)).toBe(false)
  })

  it('rejects a non-positive max', () => {
    expect(() => new BoundedSet(0)).toThrow(RangeError)
    expect(() => new BoundedSet(1.5)).toThrow(RangeError)
  })
})
