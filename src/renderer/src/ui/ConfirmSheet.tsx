import { AlertTriangle, Info, Save, Trash2, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { NavigationGuardChoice, NavigationGuardRequest, NavigationGuardService } from '../lib/navigation-guard'
import type { ReturnGuard } from '@shared/command-return-guard'
import { registerConfirmHost } from './confirm-context'
import {
  confirmSheetChoices,
  confirmSheetGuardedKeyAction,
  confirmSheetInitialFocus,
  confirmSheetKeyAction
} from './confirm-sheet-model'

/**
 * The overlay's one confirmation sheet. Given `guard`, it is the window's confirmation host: it answers that
 * guard's decisions and receives every `useConfirm()` request (see confirm-context.ts).
 */
export function ConfirmSheet({
  guard,
  request,
  onChoose,
  returnGuard
}: {
  guard?: NavigationGuardService
  request: NavigationGuardRequest | null
  onChoose?: (choice: NavigationGuardChoice, id: number) => void
  /** A confirmation that a held or repeated key must not confirm (the voice-action card). */
  returnGuard?: ReturnGuard
}): JSX.Element | null {
  useEffect(() => (guard ? registerConfirmHost(guard) : undefined), [guard])
  if (!request) return null
  const choose = onChoose ?? ((choice: NavigationGuardChoice, id: number) => guard?.choose(choice, id))
  // Keyed by request so each decision gets a fresh focus target and restores focus to its own invoker.
  return <ConfirmSheetDialog key={request.id} request={request} onChoose={choose} returnGuard={returnGuard} />
}

const neutralButton =
  'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-white/12 bg-white/[0.03] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/[0.08]'
const primaryButton =
  'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] bg-[var(--color-accent)] px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110'
const destructiveButton =
  'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] font-semibold text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/18'

function ConfirmSheetDialog({
  request,
  onChoose,
  returnGuard
}: {
  request: NavigationGuardRequest
  onChoose: (choice: NavigationGuardChoice, id: number) => void
  returnGuard?: ReturnGuard
}): JSX.Element {
  const buttonRefs = useRef<Partial<Record<NavigationGuardChoice, HTMLButtonElement | null>>>({})
  const choices = confirmSheetChoices(request)
  const confirmOnly = request.kind === 'confirm'
  const titleId = `navigation-guard-title-${request.id}`
  const messageId = `navigation-guard-message-${request.id}`

  // Initial focus on the default button (Cancel when there is deliberately no default), focus restored to the
  // invoker on close, and the sheet owns the keyboard while it is open: Escape cancels, Tab cycles inside the
  // sheet, Return activates the focused button or the default one. The listener runs in the capture phase and
  // stops the event, so the overlay's own Escape ladder never collapses or hides the window under an open sheet.
  useEffect(() => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    buttonRefs.current[confirmSheetInitialFocus(request)]?.focus()
    const onKey = (event: KeyboardEvent): void => {
      const focused = choices.findIndex((choice) => buttonRefs.current[choice] === document.activeElement)
      const action = returnGuard
        ? confirmSheetGuardedKeyAction(request, event, focused, returnGuard)
        : confirmSheetKeyAction(request, event, focused)
      if (!action) return
      event.stopPropagation()
      if (action.kind === 'activate-focused') return // the focused button's own activation clicks it
      event.preventDefault()
      if (action.kind === 'swallow') return
      if (action.kind === 'focus') buttonRefs.current[choices[action.index]]?.focus()
      else onChoose(action.choice, request.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (invoker?.isConnected) invoker.focus()
    }
    // One registration per decision: the dialog is keyed by request id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const button = (choice: NavigationGuardChoice, className: string, icon: JSX.Element | null, label: string) => (
    <button
      key={choice}
      ref={(element) => {
        buttonRefs.current[choice] = element
      }}
      type="button"
      onClick={(event) => {
        // A click the keyboard synthesised inside the guard window is a held key, not a decision.
        if (returnGuard && choice !== 'cancel' && !returnGuard.acceptsClick(event)) return
        onChoose(choice, request.id)
      }}
      className={className}
      data-metis-meeting-start={request.startsMeeting && choice !== 'cancel' ? '' : undefined}
    >
      {icon}
      {label}
    </button>
  )

  const caution = !confirmOnly || request.destructive
  return (
    <div className="pointer-events-auto absolute inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 rounded-[20px] bg-black/45 backdrop-blur-sm" />
      <section
        role={confirmOnly ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="glass-strong relative w-full max-w-[420px] rounded-2xl border border-white/15 p-4 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div
            className={
              caution
                ? 'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-warn)]/14 text-[color:var(--color-warn)]'
                : 'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-accent)]/14 text-[color:var(--color-accent-text)]'
            }
          >
            {caution ? <AlertTriangle size={18} aria-hidden="true" /> : <Info size={18} aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 text-[14px] font-semibold text-[color:var(--color-ink)]">
              {request.title}
            </h2>
            <p
              id={messageId}
              className="m-0 mt-1 whitespace-pre-wrap text-[12px] leading-snug text-[color:var(--color-ink-2)]"
            >
              {request.message}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {button('cancel', neutralButton, <X size={13} aria-hidden="true" />, request.cancelLabel ?? 'Cancel')}
          {confirmOnly
            ? button(
                'save',
                request.destructive ? destructiveButton : primaryButton,
                null,
                request.saveLabel ?? 'Continue'
              )
            : [
                button(
                  'discard',
                  request.destructive
                    ? destructiveButton
                    : 'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-white/12 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-ink)] transition-colors hover:bg-white/[0.1]',
                  <Trash2 size={13} aria-hidden="true" />,
                  request.discardLabel ?? 'Discard'
                ),
                button('save', primaryButton, <Save size={13} aria-hidden="true" />, request.saveLabel ?? 'Save')
              ]}
        </div>
      </section>
    </div>
  )
}
