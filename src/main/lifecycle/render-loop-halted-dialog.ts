/**
 * render-loop-halted-dialog.ts — the recovery surface render-process-gone falls back to once
 * lifecycle/reload-budget.ts has exhausted its automatic-reload budget (B3-RC2). This module owns the
 * button list, the response-to-action mapping, the re-prompt after a non-terminal action, and the
 * guard against acting on a dialog whose target went away while it was on screen.
 *
 * It takes Electron's `dialog.showMessageBox` and the four possible actions as arguments instead of
 * importing 'electron' or anything from index.ts, so it stays a plain, unit-testable function: the
 * caller (index.ts) decides what "Reload"/"Quit"/"Open meetings folder"/"Copy diagnostics" actually do,
 * and what "the target is gone" means (destroyed, or replaced by a successor window).
 */

import type { RenderProcessGoneReason } from './reload-budget'

/** Matches the subset of `dialog.showMessageBox` this module calls — see electron.d.ts. */
export type ShowMessageBox = (options: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>

export interface RenderLoopHaltedDialogActions {
  /** A deliberate, user-approved retry — bypasses the reload budget, which only bounds automatic reloads. */
  reload(): void
  quit(): void
  /**
   * Omit this action entirely (leave it `undefined`) when the caller's own authorization check would
   * refuse it — e.g. index.ts gates the equivalent IPC.openPath handler on `requireAuth()`. Omitting the
   * action removes the button, rather than showing a button whose click does nothing.
   */
  openMeetingsFolder?(): Promise<void>
  copyDiagnostics(): void
}

const TITLE = 'Métis keeps crashing'
const MESSAGE = "Métis' display stopped responding and stopped reloading automatically."

export function formatRenderLoopDiagnostics(input: {
  version: string
  platform: string
  arch: string
  packaged: boolean
  reason: string
  exitCode: number
  at: string
}): string {
  return [
    'Métis diagnostics',
    `version: ${input.version}`,
    `platform: ${input.platform} ${input.arch}`,
    `packaged: ${input.packaged}`,
    `render-process-gone reason=${input.reason} exitCode=${input.exitCode}`,
    input.at
  ].join('\n')
}

/**
 * Shows the halted-recovery dialog and dispatches the chosen action. "Open meetings folder" and "Copy
 * diagnostics" are non-terminal: they loop back to re-show the dialog afterward so the user still gets
 * to choose Reload or Quit. `isTargetGone` is re-checked before every prompt and again once each prompt
 * resolves, since the target can be destroyed or replaced by a successor window while the dialog (or an
 * action's own await, e.g. opening a folder) is in flight.
 */
export async function showRenderLoopHaltedDialog(
  reason: RenderProcessGoneReason,
  exitCode: number,
  isTargetGone: () => boolean,
  showMessageBox: ShowMessageBox,
  actions: RenderLoopHaltedDialogActions
): Promise<void> {
  const buttons = ['Reload', 'Quit', ...(actions.openMeetingsFolder ? ['Open meetings folder'] : []), 'Copy diagnostics']
  for (;;) {
    if (isTargetGone()) return
    const { response } = await showMessageBox({
      type: 'error',
      title: TITLE,
      message: MESSAGE,
      detail: `Reason: ${reason} (exit code ${exitCode}). Diagnostics were recorded in the audit log and main.log.`,
      buttons,
      defaultId: 0,
      cancelId: 0
    })
    if (isTargetGone()) return
    const label = buttons[response]
    if (label === 'Reload') return actions.reload()
    if (label === 'Quit') return actions.quit()
    if (label === 'Copy diagnostics') actions.copyDiagnostics()
    if (label === 'Open meetings folder') await actions.openMeetingsFolder?.()
    // Non-terminal (or, given the fixed button list above, unreachable): loop back and re-prompt so the
    // user still gets to choose Reload or Quit, with isTargetGone() re-checked at the top.
  }
}
