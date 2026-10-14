import type { QuitTrace } from './quit-trace'

type FatalKind = 'uncaughtException' | 'unhandledRejection'
type FatalDialogOptions = {
  type: 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/** Own the existing first-fatal decision and dialog behavior while exposing only fixed quit observations. */
export function createFatalHandler(deps: {
  quitTrace: QuitTrace
  platform: string
  isOrphanScreenSourcesRejection(error: unknown, platform: string): boolean
  persistCrash(kind: FatalKind, detail: string, shortMessage: string): void
  warnCaptureRefusal(): void
  showMessageBox(options: FatalDialogOptions): Promise<{ response: number }>
  exitAndRelaunch(): void
}): { onFatal(kind: FatalKind, error: unknown): void } {
  let fatalHandled = false

  async function showFatalDialog(traceDuringQuit: boolean): Promise<void> {
    try {
      const dialogOpts: FatalDialogOptions = {
        type: 'error',
        title: 'Métis hit a problem',
        message: 'Métis ran into an unexpected error.',
        detail: 'A crash report was saved to your Métis data folder. Relaunch now, or keep going.',
        buttons: ['Relaunch Métis', 'Continue'],
        defaultId: 1,
        cancelId: 1
      }
      if (traceDuringQuit) deps.quitTrace.mark('FATAL_DIALOG_CALL_ENTER')
      const dialogPromise = deps.showMessageBox(dialogOpts)
      if (traceDuringQuit) deps.quitTrace.mark('FATAL_DIALOG_CALL_RETURNED')
      const { response } = await dialogPromise
      if (traceDuringQuit) deps.quitTrace.mark('FATAL_DIALOG_SETTLED')
      if (response === 0) deps.exitAndRelaunch()
    } catch {
      if (traceDuringQuit) deps.quitTrace.mark('FATAL_DIALOG_REJECTED')
      /* if the dialog itself fails, leave the app running */
    }
  }

  function onFatal(kind: FatalKind, error: unknown): void {
    // A refused macOS capture, already audited by its caller, is not a crash.
    if (kind === 'unhandledRejection' && deps.isOrphanScreenSourcesRejection(error, deps.platform)) {
      deps.warnCaptureRefusal()
      return
    }
    const duringQuit = deps.quitTrace.quitRequested
    if (duringQuit)
      deps.quitTrace.mark(kind === 'uncaughtException' ? 'FATAL_UNCAUGHT_DURING_QUIT' : 'FATAL_REJECTION_DURING_QUIT')
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    deps.persistCrash(kind, detail, error instanceof Error ? error.message : String(error))
    if (duringQuit) deps.quitTrace.mark('FATAL_PERSIST_RETURNED')
    if (kind !== 'uncaughtException') return
    if (fatalHandled) {
      if (duringQuit) deps.quitTrace.mark('FATAL_ALREADY_HANDLED')
      return
    }
    fatalHandled = true
    if (duringQuit) deps.quitTrace.mark('FATAL_FIRST_DIALOG')
    void showFatalDialog(duringQuit)
  }

  return { onFatal }
}
