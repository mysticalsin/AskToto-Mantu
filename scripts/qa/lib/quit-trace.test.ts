import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { attachQuitTraceStdout, createQuitTraceCollector } from './quit-trace.mjs'

describe('quit trace collector', () => {
  it('accepts only known tokens and reconstructs bounded phase counts', () => {
    const collector = createQuitTraceCollector(true)
    collector.feed('[METIS_QUIT_TRACE] QUIT_CALL_ENTER_IPC\n[METIS_QUIT_TRACE] QUIT_CALL_NESTED\n')

    expect(collector.snapshot()).toMatchObject({
      phases: ['QUIT_CALL_ENTER_IPC', 'QUIT_CALL_NESTED'],
      counts: { QUIT_CALL_ENTER_IPC: 1, QUIT_CALL_NESTED: 1 },
      overflow: false,
      valid: true
    })
  })

  it('isolates stdout trace framing from interleaved stderr output', () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const collector = createQuitTraceCollector(true)
    attachQuitTraceStdout(collector, stdout)

    stdout.write('[METIS_QUIT_TRACE] BEFORE_')
    stderr.write('[METIS_QUIT_TRACE] private-error-content\n')
    stdout.write('QUIT_ENTER\n')

    expect(collector.snapshot()).toMatchObject({
      phases: ['BEFORE_QUIT_ENTER'],
      counts: { BEFORE_QUIT_ENTER: 1 },
      valid: true
    })
    stdout.destroy()
    stderr.destroy()
  })

  it('consumes an unterminated final record once across repeated snapshots', () => {
    const collector = createQuitTraceCollector(true)
    collector.feed('[METIS_QUIT_TRACE] BEFORE_QUIT_ENTER')

    expect(collector.snapshot()).toMatchObject({
      phases: ['BEFORE_QUIT_ENTER'],
      counts: { BEFORE_QUIT_ENTER: 1 }
    })
    expect(collector.snapshot()).toMatchObject({
      phases: ['BEFORE_QUIT_ENTER'],
      counts: { BEFORE_QUIT_ENTER: 1 }
    })
  })

  it('fails closed on unknown and oversized diagnostic tokens', () => {
    const unknown = createQuitTraceCollector(true)
    unknown.feed('[METIS_QUIT_TRACE] /tmp/private-path\n')
    expect(unknown.snapshot().valid).toBe(false)

    const oversized = createQuitTraceCollector(true)
    oversized.feed(`[METIS_QUIT_TRACE] ${'X'.repeat(90)}`)
    expect(oversized.snapshot().valid).toBe(false)
  })

  it('marks a truncated sequence incomplete and ignores diagnostics when disabled', () => {
    const truncated = createQuitTraceCollector(true)
    for (let index = 0; index < 97; index += 1) truncated.feed('[METIS_QUIT_TRACE] BEFORE_QUIT_ENTER\n')
    expect(truncated.snapshot()).toMatchObject({ overflow: true, valid: false, phases: { length: 96 } })

    const disabled = createQuitTraceCollector(false)
    disabled.feed('[METIS_QUIT_TRACE] /tmp/private-path\n')
    expect(disabled.snapshot()).toEqual({
      enabled: false,
      phases: [],
      counts: expect.any(Object),
      overflow: false,
      valid: false
    })
  })
})
