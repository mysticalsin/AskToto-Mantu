export const QUIT_TRACE_PREFIX = '[METIS_QUIT_TRACE] '
const COUNT_PREFIX = '[METIS_QUIT_COUNT] '

export const QUIT_TRACE_PHASES = Object.freeze([
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
  'APP_QUIT',
  'TRACE_OVERFLOW'
])

const KNOWN_PHASES = new Set(QUIT_TRACE_PHASES)
const EVENT_LIMIT = 96
const COUNT_LIMIT = 255
const PREFIX_BUFFER_LIMIT = 80

export function attachQuitTraceStdout(collector, stdout) {
  stdout?.on('data', (chunk) => collector.feed(chunk.toString('utf8')))
}

export function createQuitTraceCollector(enabled) {
  const counts = Object.fromEntries(QUIT_TRACE_PHASES.map((phase) => [phase, 0]))
  const phases = []
  let pending = ''
  let overflow = false
  let invalid = false
  let summaryCounts = null

  const acceptLine = (line) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (normalized.startsWith(COUNT_PREFIX)) {
      const count = normalized.slice(COUNT_PREFIX.length).match(/^([A-Z0-9_]+):([0-9]{1,3})$/)
      if (!count || !KNOWN_PHASES.has(count[1]) || count[1] === 'TRACE_OVERFLOW' || Number(count[2]) > COUNT_LIMIT) {
        invalid = true
        return
      }
      summaryCounts ??= Object.fromEntries(QUIT_TRACE_PHASES.map((known) => [known, 0]))
      summaryCounts[count[1]] = Number(count[2])
      return
    }
    if (!normalized.startsWith(QUIT_TRACE_PREFIX)) return
    const phase = normalized.slice(QUIT_TRACE_PREFIX.length)
    if (!KNOWN_PHASES.has(phase)) {
      invalid = true
      return
    }
    if (counts[phase] < COUNT_LIMIT) counts[phase] += 1
    else overflow = true
    if (phase === 'TRACE_OVERFLOW') overflow = true
    if (phases.length < EVENT_LIMIT) phases.push(phase)
    else overflow = true
  }

  return {
    feed(chunk) {
      if (!enabled || invalid) return
      const input = typeof chunk === 'string' ? chunk : String(chunk)
      const pieces = `${pending}${input}`.split('\n')
      pending = pieces.pop() ?? ''
      for (const line of pieces) acceptLine(line)
      if (pending.length > PREFIX_BUFFER_LIMIT) {
        if (pending.startsWith(QUIT_TRACE_PREFIX)) invalid = true
        pending = ''
      }
    },
    snapshot() {
      if (enabled && pending) {
        acceptLine(pending)
        pending = ''
      }
      return {
        enabled: Boolean(enabled),
        phases: [...phases],
        counts: summaryCounts ? { ...summaryCounts } : { ...counts },
        overflow,
        valid: Boolean(enabled) && phases.length > 0 && !invalid && !overflow
      }
    }
  }
}
