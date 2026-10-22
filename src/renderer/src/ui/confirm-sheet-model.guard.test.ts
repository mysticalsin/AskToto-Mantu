import { describe, expect, it } from 'vitest'
import { createReturnGuard } from '@shared/command-return-guard'
import { confirmSheetGuardedKeyAction } from './confirm-sheet-model'

const confirm = { kind: 'confirm' as const }

function guarded() {
  let now = 0
  const guard = createReturnGuard({ now: () => now })
  return { guard, advance: (ms: number) => (now += ms) }
}

describe('ConfirmSheet keyboard map with a Return guard (confirmation card)', () => {
  it('swallows Return inside the guard window instead of letting the focused button click natively', () => {
    const { guard, advance } = guarded()
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Enter' }, 1, guard)).toEqual({ kind: 'swallow' })
    advance(299)
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Enter' }, 1, guard)).toEqual({ kind: 'swallow' })
  })

  it('chooses the focused button on a fresh Return after the window, and the default when none is focused', () => {
    const { guard, advance } = guarded()
    advance(300)
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Enter' }, 1, guard)).toEqual({
      kind: 'choose',
      choice: 'save'
    })
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Enter' }, 0, guard)).toEqual({
      kind: 'choose',
      choice: 'cancel'
    })
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Enter' }, -1, guard)).toEqual({
      kind: 'choose',
      choice: 'save'
    })
  })

  it('swallows an auto-repeat Return however long ago the card appeared', () => {
    const { guard, advance } = guarded()
    advance(10_000)
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Enter', repeat: true }, 1, guard)).toEqual({ kind: 'swallow' })
  })

  it('never delays Escape or Tab: cancelling is always safe', () => {
    const { guard } = guarded()
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Escape' }, 1, guard)).toEqual({
      kind: 'choose',
      choice: 'cancel'
    })
    expect(confirmSheetGuardedKeyAction(confirm, { key: 'Tab' }, 1, guard)).toEqual({ kind: 'focus', index: 0 })
  })
})
