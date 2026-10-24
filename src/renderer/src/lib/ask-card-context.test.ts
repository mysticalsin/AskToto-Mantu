import { describe, expect, it, vi } from 'vitest'
import { InterventionError, validateInterventionScope } from '@shared/intervention-contract'
import { AskCardContext } from './ask-card-context'

describe('AskCardContext', () => {
  it('issues current snapshots with a valid intervention scope', () => {
    const ctx = new AskCardContext()
    const a = ctx.issue()
    const b = ctx.issue()
    expect(() => validateInterventionScope(a.scope)).not.toThrow()
    expect(b.generation).toBeGreaterThan(a.generation)
    expect(ctx.isCurrent(a)).toBe(true)
    expect(() => ctx.assertCurrent(b)).not.toThrow()
  })

  it('invalidate makes earlier snapshots stale and notifies listeners', () => {
    const ctx = new AskCardContext()
    const listener = vi.fn()
    const off = ctx.onChange(listener)
    const before = ctx.issue()
    ctx.invalidate('clear')
    expect(listener).toHaveBeenCalledWith('clear')
    expect(ctx.isCurrent(before)).toBe(false)
    expect(() => ctx.assertCurrent(before)).toThrow(InterventionError)
    expect(ctx.isCurrent(ctx.issue())).toBe(true)
    off()
    ctx.invalidate('again')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects a snapshot it did not issue', () => {
    const ctx = new AskCardContext()
    const other = new AskCardContext().issue()
    expect(ctx.isCurrent(other)).toBe(false)
    expect(() => ctx.assertCurrent(other)).toThrow(InterventionError)
    expect(ctx.isCurrent({ ...ctx.issue() })).toBe(false)
  })
})
