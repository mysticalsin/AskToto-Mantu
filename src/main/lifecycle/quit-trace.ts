/** Fixed, content-free quit observations used only by the unpackaged hosted QA smoke. */
export const QUIT_TRACE_LIMIT = 96

export const QUIT_TRACE_PHASES = [
  'IPC_QUIT_RECEIVED',
  'QUIT_CALL_ENTER_IPC',
  'QUIT_CALL_RETURNED_IPC',
  'QUIT_CALL_ENTER_PACK_RESUME',
  'QUIT_CALL_RETURNED_PACK_RESUME',
  'QUIT_CALL_ENTER_SPEECH_RESUME',
  'QUIT_CALL_RETURNED_SPEECH_RESUME',
  'QUIT_CALL_NESTED',
  'BEFORE_QUIT_ENTER',
  'BEFORE_QUIT_PREVENTED',
  'BEFORE_QUIT_ALLOWED',
  'PACK_SHUTDOWN_START',
  'PACK_ENGINE_NONE',
  'PACK_ENGINE_PRESENT',
  'PACK_SHUTDOWN_SETTLED',
  'PACK_SHUTDOWN_REJECTED',
  'PACK_QUIT_RESUME',
  'SPEECH_DISPOSE_START',
  'SPEECH_OWNERS_NONE',
  'SPEECH_OWNERS_PRESENT',
  'SPEECH_DISPOSE_SETTLED',
  'SPEECH_DISPOSE_REJECTED',
  'SPEECH_QUIT_RESUME',
  'WINDOW_CLOSE_REQUEST',
  'WINDOW_CLOSED',
  'CLOSED_CLEANUP_ENTER',
  'CLOSED_CLEANUP_RETURNED',
  'CLOSED_CLEANUP_THROWN',
  'WINDOW_UNLOAD_VETO',
  'WINDOW_STATE_C000',
  'WINDOW_STATE_C001',
  'WINDOW_STATE_C010',
  'WINDOW_STATE_C011',
  'WINDOW_STATE_C100',
  'WINDOW_STATE_C101',
  'WINDOW_STATE_C110',
  'WINDOW_STATE_C111',
  'WINDOW_STATE_UNKNOWN',
  'WINDOW_CREATE_DURING_QUIT',
  'WINDOW_REVEAL_DURING_QUIT',
  'APP_ACTIVATE_DURING_QUIT',
  'WINDOW_ALL_CLOSED',
  'WILL_QUIT_STOPALL_ENTER',
  'WILL_QUIT_STOPALL_EXIT',
  'WILL_QUIT_CLEANUP_ENTER',
  'WILL_QUIT_CLEANUP_EXIT',
  'FATAL_UNCAUGHT_DURING_QUIT',
  'FATAL_REJECTION_DURING_QUIT',
  'FATAL_PERSIST_RETURNED',
  'FATAL_FIRST_DIALOG',
  'FATAL_ALREADY_HANDLED',
  'FATAL_DIALOG_CALL_ENTER',
  'FATAL_DIALOG_CALL_RETURNED',
  'FATAL_DIALOG_SETTLED',
  'FATAL_DIALOG_REJECTED',
  'APP_QUIT',
  'TRACE_OVERFLOW'
] as const

export type QuitTracePhase = (typeof QUIT_TRACE_PHASES)[number]
export type QuitCallSite = 'IPC' | 'PACK_RESUME' | 'SPEECH_RESUME'

export type QuitTrace = {
  readonly enabled: boolean
  readonly quitRequested: boolean
  mark(phase: Exclude<QuitTracePhase, 'TRACE_OVERFLOW'>): void
  requestQuit(): void
  call(site: QuitCallSite, quit: () => void): void
  windowState(closable: boolean, fullScreen: boolean, simpleFullScreen: boolean): void
}

type QuitObservableWindow = {
  on(event: 'close' | 'closed', listener: () => void): unknown
  isClosable(): boolean
  isFullScreen(): boolean
  isSimpleFullScreen(): boolean
  webContents: { on(event: 'will-prevent-unload', listener: () => void): unknown }
}

export function observeQuitWindow(window: QuitObservableWindow, trace: QuitTrace): void {
  window.on('close', () => {
    trace.mark('WINDOW_CLOSE_REQUEST')
    if (!trace.quitRequested) return
    try {
      trace.windowState(window.isClosable(), window.isFullScreen(), window.isSimpleFullScreen())
    } catch {
      trace.mark('WINDOW_STATE_UNKNOWN')
    }
  })
  window.on('closed', () => trace.mark('WINDOW_CLOSED'))
  window.webContents.on('will-prevent-unload', () => trace.mark('WINDOW_UNLOAD_VETO'))
}

/** Bracket the existing closed cleanup and rethrow its exact failure without turning it into success. */
export function observeClosedCleanup(trace: QuitTrace, cleanup: () => void): void {
  trace.mark('CLOSED_CLEANUP_ENTER')
  try {
    cleanup()
  } catch (error) {
    trace.mark('CLOSED_CLEANUP_THROWN')
    throw error
  }
  trace.mark('CLOSED_CLEANUP_RETURNED')
}

/** Record only fixed tokens. Diagnostics never change shutdown decisions or wait for output. */
export function createQuitTrace(enabled: boolean, write: (line: string) => void): QuitTrace {
  let quitRequested = false
  let depth = 0
  let written = 0
  let overflow = false
  const counts = new Map<Exclude<QuitTracePhase, 'TRACE_OVERFLOW'>, number>()
  const writeFixed = (line: string): void => {
    try {
      write(line)
    } catch {
      /* diagnostic output must never alter the quit path */
    }
  }
  const mark = (phase: Exclude<QuitTracePhase, 'TRACE_OVERFLOW'>): void => {
    if (!enabled) return
    counts.set(phase, Math.min(255, (counts.get(phase) ?? 0) + 1))
    if (written < QUIT_TRACE_LIMIT) {
      written += 1
      writeFixed(`[METIS_QUIT_TRACE] ${phase}`)
      return
    }
    if (!overflow) {
      overflow = true
      writeFixed('[METIS_QUIT_TRACE] TRACE_OVERFLOW')
      for (const [countedPhase, count] of counts) {
        writeFixed(`[METIS_QUIT_COUNT] ${countedPhase}:${count}`)
      }
    }
  }
  const call = (site: QuitCallSite, quit: () => void): void => {
    if (!enabled) {
      quit()
      return
    }
    if (depth > 0) mark('QUIT_CALL_NESTED')
    mark(`QUIT_CALL_ENTER_${site}`)
    depth += 1
    try {
      quit()
    } finally {
      depth -= 1
      mark(`QUIT_CALL_RETURNED_${site}`)
    }
  }
  return {
    enabled,
    get quitRequested() {
      return quitRequested
    },
    mark,
    requestQuit() {
      if (enabled) quitRequested = true
    },
    call,
    windowState(closable, fullScreen, simpleFullScreen) {
      if (!enabled) return
      const state = `WINDOW_STATE_C${Number(closable)}${Number(fullScreen)}${Number(simpleFullScreen)}`
      mark(state as Exclude<QuitTracePhase, 'TRACE_OVERFLOW'>)
    }
  }
}
