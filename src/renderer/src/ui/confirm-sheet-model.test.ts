import { describe, expect, it } from 'vitest'
import {
  confirmSheetChoices,
  confirmSheetDefaultChoice,
  confirmSheetInitialFocus,
  confirmSheetKeyAction
} from './confirm-sheet-model'

const saveSheet = { kind: 'save-discard' as const, destructive: true }
const confirm = { kind: 'confirm' as const }
const destructiveConfirm = { kind: 'confirm' as const, destructive: true }

describe('ConfirmSheet button order and default (HIG Alerts)', () => {
  it('puts Cancel on the leading side and the action on the trailing side', () => {
    expect(confirmSheetChoices(confirm)).toEqual(['cancel', 'save'])
    expect(confirmSheetChoices(saveSheet)).toEqual(['cancel', 'discard', 'save'])
    expect(confirmSheetChoices({})).toEqual(['cancel', 'discard', 'save'])
  })

  it('makes a deliberately chosen action the default and focuses it', () => {
    expect(confirmSheetDefaultChoice(confirm)).toBe('save')
    expect(confirmSheetInitialFocus(confirm)).toBe('save')
    expect(confirmSheetInitialFocus(saveSheet)).toBe('save')
  })

  it('gives a destructive consequence no default and focuses Cancel, so Return cannot confirm it', () => {
    expect(confirmSheetDefaultChoice(destructiveConfirm)).toBeNull()
    expect(confirmSheetInitialFocus(destructiveConfirm)).toBe('cancel')
  })
})

describe('ConfirmSheet keyboard map', () => {
  it('Escape always cancels', () => {
    expect(confirmSheetKeyAction(confirm, { key: 'Escape' }, 1)).toEqual({ kind: 'choose', choice: 'cancel' })
    expect(confirmSheetKeyAction(destructiveConfirm, { key: 'Escape' }, -1)).toEqual({
      kind: 'choose',
      choice: 'cancel'
    })
  })

  it('Return activates the focused button, or the default when focus is elsewhere', () => {
    expect(confirmSheetKeyAction(confirm, { key: 'Enter' }, 0)).toEqual({ kind: 'activate-focused' })
    expect(confirmSheetKeyAction(confirm, { key: 'Enter' }, -1)).toEqual({ kind: 'choose', choice: 'save' })
    expect(confirmSheetKeyAction(destructiveConfirm, { key: 'Enter' }, -1)).toBeNull()
  })

  it('Tab and Shift-Tab cycle inside the sheet and bring stray focus back in', () => {
    expect(confirmSheetKeyAction(confirm, { key: 'Tab' }, 1)).toEqual({ kind: 'focus', index: 0 })
    expect(confirmSheetKeyAction(confirm, { key: 'Tab', shiftKey: true }, 0)).toEqual({ kind: 'focus', index: 1 })
    expect(confirmSheetKeyAction(saveSheet, { key: 'Tab' }, 2)).toEqual({ kind: 'focus', index: 0 })
    expect(confirmSheetKeyAction(saveSheet, { key: 'Tab' }, -1)).toEqual({ kind: 'focus', index: 0 })
    expect(confirmSheetKeyAction(saveSheet, { key: 'Tab', shiftKey: true }, -1)).toEqual({ kind: 'focus', index: 2 })
  })

  it('leaves other keys and IME composition alone', () => {
    expect(confirmSheetKeyAction(confirm, { key: 'a' }, 0)).toBeNull()
    expect(confirmSheetKeyAction(confirm, { key: 'Escape', isComposing: true }, 0)).toBeNull()
  })
})
