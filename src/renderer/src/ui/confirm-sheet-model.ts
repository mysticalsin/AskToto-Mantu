/**
 * confirm-sheet-model.ts — the button order, default button and keyboard map for ConfirmSheet, kept free of the
 * DOM so the macOS alert rules are unit-testable (Apple HIG, Alerts and Keyboard):
 *
 * - Cancel sits on the leading side and the default action on the trailing side.
 * - Return activates the default button; Escape always cancels.
 * - A deliberately chosen action is the default. A destructive consequence the person did not deliberately
 *   choose has no default: focus starts on Cancel, so Return never confirms it by accident.
 * - Tab and Shift-Tab cycle through the sheet's buttons and never leave the sheet while it is open.
 */
import type { NavigationGuardChoice, NavigationGuardRequest } from '../lib/navigation-guard'

/** Buttons in DOM (visual, leading to trailing) order. */
export function confirmSheetChoices(request: Pick<NavigationGuardRequest, 'kind'>): NavigationGuardChoice[] {
  return request.kind === 'confirm' ? ['cancel', 'save'] : ['cancel', 'discard', 'save']
}

/** The button Return activates, or null when the sheet deliberately has no default. */
export function confirmSheetDefaultChoice(
  request: Pick<NavigationGuardRequest, 'kind' | 'destructive'>
): NavigationGuardChoice | null {
  if (request.kind === 'confirm' && request.destructive) return null
  return 'save'
}

/** The button that receives focus when the sheet opens. */
export function confirmSheetInitialFocus(
  request: Pick<NavigationGuardRequest, 'kind' | 'destructive'>
): NavigationGuardChoice {
  return confirmSheetDefaultChoice(request) ?? 'cancel'
}

export type ConfirmSheetKeyAction =
  | { kind: 'choose'; choice: NavigationGuardChoice }
  | { kind: 'focus'; index: number }
  | { kind: 'activate-focused' }
  | null

/**
 * What a key press does while the sheet is open. `focusedIndex` is the position of the focused button in
 * `confirmSheetChoices`, or -1 when focus is outside the sheet's buttons.
 */
export function confirmSheetKeyAction(
  request: Pick<NavigationGuardRequest, 'kind' | 'destructive'>,
  key: { key: string; shiftKey?: boolean; isComposing?: boolean },
  focusedIndex: number
): ConfirmSheetKeyAction {
  if (key.isComposing) return null
  const count = confirmSheetChoices(request).length
  if (key.key === 'Escape') return { kind: 'choose', choice: 'cancel' }
  if (key.key === 'Tab') {
    if (focusedIndex < 0) return { kind: 'focus', index: key.shiftKey ? count - 1 : 0 }
    return { kind: 'focus', index: (focusedIndex + (key.shiftKey ? -1 : 1) + count) % count }
  }
  if (key.key === 'Enter') {
    // A focused button activates itself (the platform's own button behaviour); otherwise Return means the
    // default button, and does nothing when there is deliberately no default.
    if (focusedIndex >= 0) return { kind: 'activate-focused' }
    const fallback = confirmSheetDefaultChoice(request)
    return fallback ? { kind: 'choose', choice: fallback } : null
  }
  return null
}
