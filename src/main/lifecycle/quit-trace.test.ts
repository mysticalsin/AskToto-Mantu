import { describe, expect, it, vi } from 'vitest'
import { createQuitTrace, observeClosedCleanup, QUIT_TRACE_LIMIT } from './quit-trace'

describe('quit trace', () => {
  it('records nested quit calls with fixed caller categories and return order', () => {
    const lines: string[] = []
    const trace = createQuitTrace(true, (line) => lines.push(line))

    trace.call('IPC', () => trace.call('PACK_RESUME', () => undefined))

    expect(lines.map((line) => line.replace('[METIS_QUIT_TRACE] ', ''))).toEqual([
      'QUIT_CALL_ENTER_IPC',
      'QUIT_CALL_NESTED',
      'QUIT_CALL_ENTER_PACK_RESUME',
      'QUIT_CALL_RETURNED_PACK_RESUME',
      'QUIT_CALL_RETURNED_IPC'
    ])
  })

  it('records closed cleanup return and rethrows the same cleanup failure', () => {
    const lines: string[] = []
    const trace = createQuitTrace(true, (line) => lines.push(line))
    const failure = new Error('private cleanup failure')

    observeClosedCleanup(trace, () => undefined)
    let thrown: unknown
    try {
      observeClosedCleanup(trace, () => {
        throw failure
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(failure)
    expect(lines.map((line) => line.replace('[METIS_QUIT_TRACE] ', ''))).toEqual([
      'CLOSED_CLEANUP_ENTER',
      'CLOSED_CLEANUP_RETURNED',
      'CLOSED_CLEANUP_ENTER',
      'CLOSED_CLEANUP_THROWN'
    ])
  })

  it('runs closed cleanup once when disabled and when diagnostic writes fail', () => {
    const disabledWriter = vi.fn()
    const disabledTrace = createQuitTrace(false, disabledWriter)
    const disabledCleanup = vi.fn()
    observeClosedCleanup(disabledTrace, disabledCleanup)

    const failingTrace = createQuitTrace(true, () => {
      throw new Error('diagnostic writer failure')
    })
    const cleanupFailure = new Error('cleanup failure')
    const failingCleanup = vi.fn(() => {
      throw cleanupFailure
    })
    let thrown: unknown
    try {
      observeClosedCleanup(failingTrace, failingCleanup)
    } catch (error) {
      thrown = error
    }

    expect(disabledCleanup).toHaveBeenCalledOnce()
    expect(disabledWriter).not.toHaveBeenCalled()
    expect(failingCleanup).toHaveBeenCalledOnce()
    expect(thrown).toBe(cleanupFailure)
  })

  it('keeps the bounded sequence and emits one overflow marker with its count summary', () => {
    const lines: string[] = []
    const trace = createQuitTrace(true, (line) => lines.push(line))

    for (let i = 0; i < QUIT_TRACE_LIMIT + 5; i += 1) trace.mark('BEFORE_QUIT_ENTER')

    expect(lines).toHaveLength(QUIT_TRACE_LIMIT + 2)
    expect(lines.at(-2)).toBe('[METIS_QUIT_TRACE] TRACE_OVERFLOW')
    expect(lines.at(-1)).toBe('[METIS_QUIT_COUNT] BEFORE_QUIT_ENTER:97')
  })

  it('does not write or track diagnostics when disabled', () => {
    const lines: string[] = []
    const trace = createQuitTrace(false, (line) => lines.push(line))

    trace.call('IPC', () => trace.mark('BEFORE_QUIT_ENTER'))
    trace.requestQuit()

    expect(lines).toEqual([])
    expect(trace.quitRequested).toBe(false)
  })
})
