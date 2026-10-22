/**
 * Bounded plain-JSON data helpers for kernel contracts. Ported from the 2.12 reference kernel
 * (`session-context.mjs`). Only plain data crosses a contract: no executable values, no accessors.
 */

export type ContractErrorCode =
  | 'DATA_DEPTH'
  | 'DATA_STRING_LIMIT'
  | 'DATA_NUMBER'
  | 'DATA_ARRAY'
  | 'DATA_ARRAY_LIMIT'
  | 'DATA_ARRAY_ACCESSOR'
  | 'DATA_OBJECT'
  | 'DATA_KEY_LIMIT'
  | 'DATA_RESERVED_KEY'
  | 'DATA_ACCESSOR'
  | 'SCOPE_SHAPE'
  | 'SCOPE_ID'
  | 'SCOPE_MISMATCH'
  | 'PERMISSIONS_SHAPE'
  | 'PERMISSION_ID'
  | 'MODE'
  | 'OBJECTIVE'
  | 'OUTPUT_KIND'
  | 'SESSION_STOPPED'
  | 'SNAPSHOT_NOT_ISSUED'
  | 'STALE_GENERATION'
  | 'STALE_CONTEXT'
  | 'STALE_PERMISSIONS'
  | 'LISTENER'
  | 'TRANSCRIPT_REVISION'
  | 'TRANSCRIPT_SHAPE'
  | 'TRANSCRIPT_REGRESSION'
  | 'TRANSCRIPT_REVISION_COLLISION'
  | 'SCREEN_ID'
  | 'SCREEN_TIME'
  | 'KNOWLEDGE_SHAPE'
  | 'QUEUE_LIMIT'
  | 'QUEUE_TIMEOUT'
  | 'QUEUE_CLOSED'
  | 'QUEUE_FULL'
  | 'TASK_FUNCTION'
  | 'TASK_INVALIDATED'
  | 'TASK_CANCELLED'
  | 'TASK_TIMEOUT'

export class ContractError extends Error {
  readonly code: ContractErrorCode

  constructor(code: ContractErrorCode, message: string = code) {
    super(message)
    this.name = 'ContractError'
    this.code = code
  }
}

export function requireCondition(condition: unknown, code: ContractErrorCode): asserts condition {
  if (!condition) throw new ContractError(code)
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const MAX_DEPTH = 20
const MAX_STRING = 65_536
const MAX_ARRAY = 1_024
const MAX_KEYS = 128
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Deep copy of bounded plain JSON data. Object keys come back sorted so the copy is canonical. */
export function copyData(value: unknown, depth = 0): JsonValue {
  requireCondition(depth <= MAX_DEPTH, 'DATA_DEPTH')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    requireCondition(value.length <= MAX_STRING, 'DATA_STRING_LIMIT')
    return value
  }
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value), 'DATA_NUMBER')
    return value
  }
  if (Array.isArray(value)) {
    requireCondition(Object.getPrototypeOf(value) === Array.prototype, 'DATA_ARRAY')
    requireCondition(value.length <= MAX_ARRAY, 'DATA_ARRAY_LIMIT')
    const result: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      requireCondition(descriptor && 'value' in descriptor, 'DATA_ARRAY_ACCESSOR')
      result.push(copyData(descriptor.value, depth + 1))
    }
    return result
  }
  requireCondition(
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype,
    'DATA_OBJECT'
  )
  const keys = Object.keys(value).sort()
  requireCondition(keys.length <= MAX_KEYS, 'DATA_KEY_LIMIT')
  const result: { [key: string]: JsonValue } = {}
  for (const key of keys) {
    requireCondition(!RESERVED_KEYS.has(key), 'DATA_RESERVED_KEY')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    requireCondition(descriptor && 'value' in descriptor, 'DATA_ACCESSOR')
    Object.defineProperty(result, key, {
      value: copyData(descriptor.value, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return result
}

export function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  return value
}

export const canonical = (value: unknown): string => JSON.stringify(copyData(value))
