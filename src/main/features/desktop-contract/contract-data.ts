import { createHash } from 'node:crypto'

/**
 * Plain-data helpers shared by the dictation target guard and the routine coordinator.
 * Ported from the 2.12 reference modules (contract-data.mjs and the data helpers of the session
 * context kernel). Only bounded, frozen, plain JSON crosses these contracts; no executable values.
 */
export class DesktopContractError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'DesktopContractError'
    this.code = code
  }
}

export function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new DesktopContractError(code)
}

const IDENTIFIER = /^[A-Za-z0-9_.:@/-]{1,160}$/

export function ident(value: unknown, code = 'IDENTIFIER'): string {
  check(typeof value === 'string' && IDENTIFIER.test(value), code)
  return value
}

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface DataLimits {
  maxDepth: number
  maxStringBytes: number
  maxArray: number
  maxKeys: number
}

/** Limits of the dictation contract (stricter arrays and keys, byte-measured strings). */
export const DICTATION_DATA_LIMITS: DataLimits = {
  maxDepth: 16,
  maxStringBytes: 65_536,
  maxArray: 256,
  maxKeys: 64
}

/** Limits of the session-context kernel the routine contract was written against. */
export const ROUTINE_DATA_LIMITS: DataLimits = {
  maxDepth: 20,
  maxStringBytes: 65_536,
  maxArray: 1_024,
  maxKeys: 128
}

function copyWithLimits(value: unknown, limits: DataLimits, depth: number): unknown {
  check(depth <= limits.maxDepth, 'DATA_DEPTH')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    check(Buffer.byteLength(value, 'utf8') <= limits.maxStringBytes, 'DATA_SIZE')
    return value
  }
  if (typeof value === 'number') {
    check(Number.isFinite(value), 'DATA_NUMBER')
    return value
  }
  if (Array.isArray(value)) {
    check(Object.getPrototypeOf(value) === Array.prototype && value.length <= limits.maxArray, 'DATA_ARRAY')
    const items: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index))
      check(entry && 'value' in entry, 'DATA_ACCESSOR')
      items.push(copyWithLimits(entry.value, limits, depth + 1))
    }
    return items
  }
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'DATA_OBJECT')
  const keys = Object.keys(value).sort()
  check(keys.length <= limits.maxKeys, 'DATA_KEYS')
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    check(!RESERVED_KEYS.has(key), 'DATA_RESERVED')
    const entry = Object.getOwnPropertyDescriptor(value, key)
    check(entry && 'value' in entry, 'DATA_ACCESSOR')
    result[key] = copyWithLimits(entry.value, limits, depth + 1)
  }
  return result
}

/** Deep-freezes a plain value in place and returns it. */
export function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  return value
}

/** Validated, key-sorted, deep-frozen copy using the dictation limits. */
export function data<T>(value: T): Readonly<T> {
  return freezeData(copyWithLimits(value, DICTATION_DATA_LIMITS, 0)) as Readonly<T>
}

/** Validated, key-sorted, mutable copy using the routine limits. Freeze it explicitly if needed. */
export function copyData<T>(value: T): T {
  return copyWithLimits(value, ROUTINE_DATA_LIMITS, 0) as T
}

export const canonical = (value: unknown): string => JSON.stringify(copyData(value))
export const dictationCanonical = (value: unknown): string => JSON.stringify(data(value))
export const digest = (value: unknown): string => createHash('sha256').update(dictationCanonical(value)).digest('hex')
export const textDigest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** Reads an injected clock and rejects anything that is not a bounded non-negative integer. */
export function time(clock: () => number): number {
  const result = clock()
  check(Number.isSafeInteger(result) && result >= 0 && result < Number.MAX_SAFE_INTEGER - 86_400_000, 'CLOCK')
  return result
}

export function exactKeys(value: unknown, names: readonly string[], code: string): void {
  check(value && typeof value === 'object' && Object.keys(value).sort().join('|') === [...names].sort().join('|'), code)
}
