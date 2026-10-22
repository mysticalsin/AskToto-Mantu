import { describe, expect, it } from 'vitest'
import { neighborAfterRemoval, rowStep, tabStopFile } from './list-keyboard'

describe('History list keyboard model', () => {
  it('Up and Down move one row, Home and End jump, and the ends hold', () => {
    expect(rowStep('ArrowDown', 0, 3)).toBe(1)
    expect(rowStep('ArrowDown', 2, 3)).toBe(2)
    expect(rowStep('ArrowUp', 2, 3)).toBe(1)
    expect(rowStep('ArrowUp', 0, 3)).toBe(0)
    expect(rowStep('Home', 2, 3)).toBe(0)
    expect(rowStep('End', 0, 3)).toBe(2)
  })

  it('ignores other keys and an empty list', () => {
    expect(rowStep('Enter', 0, 3)).toBeNull()
    expect(rowStep('a', 0, 3)).toBeNull()
    expect(rowStep('ArrowDown', 0, 0)).toBeNull()
  })

  it('focus after a delete lands on the next row, else the previous, else nowhere', () => {
    expect(neighborAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(neighborAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(neighborAfterRemoval(['a'], 'a')).toBeNull()
    expect(neighborAfterRemoval(['a', 'b'], 'zzz')).toBeNull()
  })

  it('the one Tab stop is the selected row, else the first', () => {
    expect(tabStopFile(['a', 'b', 'c'], 'b')).toBe('b')
    expect(tabStopFile(['a', 'b', 'c'], null)).toBe('a')
    expect(tabStopFile(['a', 'b', 'c'], 'gone')).toBe('a')
    expect(tabStopFile([], 'a')).toBeNull()
  })
})
