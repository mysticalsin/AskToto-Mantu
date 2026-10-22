import { describe, expect, it } from 'vitest'
import { ContractError, canonical, copyData, freezeData, requireCondition } from './contract-data'

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return error instanceof ContractError ? error.code : `other:${String(error)}`
  }
  return undefined
}

describe('copyData', () => {
  it('copies bounded plain data and sorts object keys', () => {
    const copy = copyData({ b: 1, a: { z: [1, 'x', null, true], y: 2 } })
    expect(Object.keys(copy as object)).toEqual(['a', 'b'])
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('detaches the copy from the input', () => {
    const input = { nested: { value: 'a' } }
    const copy = copyData(input) as typeof input
    input.nested.value = 'b'
    expect(copy.nested.value).toBe('a')
  })

  it('rejects executable values, class instances and undefined', () => {
    expect(codeOf(() => copyData({ run: () => 'code' }))).toBe('DATA_OBJECT')
    expect(codeOf(() => copyData(new Date()))).toBe('DATA_OBJECT')
    expect(codeOf(() => copyData({ a: undefined }))).toBe('DATA_OBJECT')
    expect(codeOf(() => copyData(Object.create(null)))).toBe('DATA_OBJECT')
  })

  it('rejects accessor properties without executing them', () => {
    const accessor = {}
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not execute')
      }
    })
    expect(codeOf(() => copyData(accessor))).toBe('DATA_ACCESSOR')
    const arrayAccessor: unknown[] = []
    Object.defineProperty(arrayAccessor, '0', {
      enumerable: true,
      get() {
        throw new Error('must not execute')
      }
    })
    expect(codeOf(() => copyData(arrayAccessor))).toBe('DATA_ARRAY_ACCESSOR')
  })

  it('rejects reserved keys, non-finite numbers and over-limit data', () => {
    expect(codeOf(() => copyData(JSON.parse('{"__proto__":1}')))).toBe('DATA_RESERVED_KEY')
    expect(codeOf(() => copyData({ constructor: 1 }))).toBe('DATA_RESERVED_KEY')
    expect(codeOf(() => copyData(Number.NaN))).toBe('DATA_NUMBER')
    expect(codeOf(() => copyData(Number.POSITIVE_INFINITY))).toBe('DATA_NUMBER')
    expect(codeOf(() => copyData('x'.repeat(65_537)))).toBe('DATA_STRING_LIMIT')
    expect(codeOf(() => copyData(new Array(1_025).fill(0)))).toBe('DATA_ARRAY_LIMIT')
    const wide = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, index]))
    expect(codeOf(() => copyData(wide))).toBe('DATA_KEY_LIMIT')
    let deep: unknown = 1
    for (let index = 0; index < 22; index += 1) deep = { deep }
    expect(codeOf(() => copyData(deep))).toBe('DATA_DEPTH')
  })

  it('rejects symbols, bigints and functions at the top level', () => {
    expect(codeOf(() => copyData(Symbol('x')))).toBe('DATA_OBJECT')
    expect(codeOf(() => copyData(1n))).toBe('DATA_OBJECT')
    expect(codeOf(() => copyData(() => 1))).toBe('DATA_OBJECT')
  })
})

describe('freezeData and requireCondition', () => {
  it('deep-freezes nested data', () => {
    const frozen = freezeData(copyData({ a: { b: [1, { c: 2 }] } })) as { a: { b: [number, { c: number }] } }
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.a.b[1])).toBe(true)
    expect(() => {
      frozen.a.b[1].c = 3
    }).toThrow(TypeError)
  })

  it('throws a ContractError with the code and name', () => {
    expect(() => requireCondition(true, 'SCOPE_ID')).not.toThrow()
    try {
      requireCondition(false, 'SCOPE_ID')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError)
      expect((error as ContractError).code).toBe('SCOPE_ID')
      expect((error as ContractError).name).toBe('ContractError')
    }
  })
})
