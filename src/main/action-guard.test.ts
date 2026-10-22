import { describe, expect, it } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import {
  ACTION_DEPENDENCY_LIMIT,
  actionArgsHash,
  actionEnvelope,
  actionIdempotencyKey,
  checkDependsOn,
  isArgsHash,
  isBoundReceipt,
  isObservedVerified
} from './action-guard'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'hello' } }
const PROPOSAL = 'a'.repeat(32)

describe('action argsHash', () => {
  it('is a SHA-256 digest that ignores key order and changes with the action or its arguments', () => {
    const hash = actionArgsHash(NOTE)
    expect(isArgsHash(hash)).toBe(true)
    expect(actionArgsHash(JSON.parse('{"args":{"title":"hello"},"id":"desktop.create_note"}'))).toBe(hash)
    expect(actionArgsHash({ id: 'desktop.create_note', args: { title: 'other' } })).not.toBe(hash)
    expect(actionArgsHash({ id: 'desktop.open_notes', args: {} })).not.toBe(hash)
  })

  it.each([undefined, null, 5, '', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])('rejects %s as a hash', (value) => {
    expect(isArgsHash(value)).toBe(false)
  })
})

describe('action idempotency key', () => {
  it('is deterministic per proposal and arguments, and never shared between proposals', () => {
    const hash = actionArgsHash(NOTE)
    expect(actionIdempotencyKey(PROPOSAL, hash)).toBe(actionIdempotencyKey(PROPOSAL, hash))
    expect(actionIdempotencyKey('b'.repeat(32), hash)).not.toBe(actionIdempotencyKey(PROPOSAL, hash))
    expect(
      actionIdempotencyKey(PROPOSAL, actionArgsHash({ id: 'desktop.create_note', args: { title: 'x' } }))
    ).not.toBe(actionIdempotencyKey(PROPOSAL, hash))
    expect(actionEnvelope(PROPOSAL, NOTE)).toEqual({
      argsHash: hash,
      idempotencyKey: actionIdempotencyKey(PROPOSAL, hash)
    })
  })
})

describe('action dependencies', () => {
  it('accepts a bounded list of unique proposal ids', () => {
    expect(checkDependsOn([])).toEqual({ ok: true, dependsOn: [] })
    expect(checkDependsOn(['b'.repeat(32), 'c'.repeat(32)])).toEqual({
      ok: true,
      dependsOn: ['b'.repeat(32), 'c'.repeat(32)]
    })
  })

  it('rejects malformed, duplicate and oversized lists', () => {
    expect(checkDependsOn('b'.repeat(32))).toEqual({ ok: false, reason: 'DEPENDENCY_INVALID' })
    expect(checkDependsOn(['not-an-id'])).toEqual({ ok: false, reason: 'DEPENDENCY_INVALID' })
    expect(checkDependsOn([7])).toEqual({ ok: false, reason: 'DEPENDENCY_INVALID' })
    expect(checkDependsOn(['b'.repeat(32), 'b'.repeat(32)])).toEqual({ ok: false, reason: 'DEPENDENCY_DUPLICATE' })
    const many = Array.from({ length: ACTION_DEPENDENCY_LIMIT + 1 }, (_, i) => i.toString(16).padStart(32, '0'))
    expect(checkDependsOn(many)).toEqual({ ok: false, reason: 'DEPENDENCY_LIMIT' })
  })
})

describe('observed-receipt rule', () => {
  const envelope = actionEnvelope(PROPOSAL, NOTE)
  const receipt = { ...envelope, observation: 'Note "hello" is present in Notes' }
  const verified: DesktopActionResult = { id: 'desktop.create_note', ok: true, outcome: 'verified', receipt }

  it('verifies only a result with a receipt bound to this key and hash', () => {
    expect(isObservedVerified(NOTE, verified, envelope)).toBe(true)
    expect(isBoundReceipt(receipt, envelope)).toBe(true)
  })

  it.each([
    ['no receipt', { receipt: undefined }],
    ['a receipt for another key', { receipt: { ...receipt, idempotencyKey: 'f'.repeat(64) } }],
    ['a receipt for other arguments', { receipt: { ...receipt, argsHash: 'f'.repeat(64) } }],
    ['an empty observation', { receipt: { ...receipt, observation: '   ' } }],
    ['an oversized observation', { receipt: { ...receipt, observation: 'x'.repeat(1_001) } }],
    ['a result for another action', { id: 'desktop.open_notes' as const }],
    ['ok false', { ok: false }],
    ['an unknown outcome', { outcome: 'unknown' as const }]
  ])('does not verify %s', (_name, override) => {
    expect(isObservedVerified(NOTE, { ...verified, ...override }, envelope)).toBe(false)
  })
})
