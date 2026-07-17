import { describe, it, expect, vi } from 'vitest'

// fm-runtime.ts imports auditLog/mainLog from ../logger, which imports `app` from electron — mock the
// logger (mirrors local-runtime.test.ts's mocking style for the same import chain).
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import {
  buildServeArgs,
  stripAnsi,
  parseAvailability,
  supported,
  disabledByEnv,
  probeAvailability,
  start,
  stop,
  isRunning,
  getState,
  baseURL,
  beginStream,
  endStream,
  activeStreams,
  FM_BINARY_PATH,
  FM_SYSTEM_MODEL
} from './fm-runtime'

describe('buildServeArgs', () => {
  it('produces the exact serve argv — loopback host is load-bearing (no-auth server)', () => {
    expect(buildServeArgs(1976)).toEqual(['serve', '--host', '127.0.0.1', '--port', '1976'])
  })

  it('never binds beyond loopback', () => {
    expect(buildServeArgs(4242)).not.toContain('0.0.0.0')
  })
})

describe('stripAnsi', () => {
  it('removes the 24-bit color codes fm actually emits', () => {
    expect(stripAnsi('[38;2;255;107;128mPCC inference is not available[0m')).toBe(
      'PCC inference is not available'
    )
  })
})

describe('parseAvailability', () => {
  // Verbatim output observed on macOS 27.0 (25A5378n) with Apple Intelligence toggled OFF — the exact
  // machine state this feature must degrade gracefully in.
  const DISABLED_OUTPUT =
    'Error: [38;2;255;107;128mPCC inference is not available in this context.[0m\n' +
    'System model unavailable: appleIntelligenceNotEnabled\n'

  it('parses the observed Apple-Intelligence-off output to unavailable with the OS reason', () => {
    expect(parseAvailability(DISABLED_OUTPUT)).toEqual({
      available: false,
      reason: 'appleIntelligenceNotEnabled'
    })
  })

  it('the PCC error line alone never decides — only the System model line does', () => {
    // PCC is App Store-entitlement-gated and expected to be unavailable for a Developer ID app; the
    // on-device system model is what the local engine runs on.
    const out = 'Error: PCC inference is not available in this context.\nSystem model available\n'
    expect(parseAvailability(out)).toEqual({ available: true, reason: null })
  })

  it.each(['System model available', 'System model is available.', '  system model AVAILABLE '])(
    'tolerantly accepts enabled-format variants: %j',
    (line) => {
      expect(parseAvailability(line).available).toBe(true)
    }
  )

  it('an unavailable line without a reason still parses as unavailable', () => {
    expect(parseAvailability('System model unavailable:')).toEqual({ available: false, reason: 'unknown' })
  })

  it('unrecognized output is conservatively unavailable (probe-unparsed), never a crash', () => {
    expect(parseAvailability('something completely different')).toEqual({
      available: false,
      reason: 'probe-unparsed'
    })
    expect(parseAvailability('')).toEqual({ available: false, reason: 'probe-unparsed' })
  })
})

describe('supported', () => {
  it('is false on every non-darwin platform regardless of any binary', () => {
    expect(supported('win32', () => true)).toBe(false)
    expect(supported('linux', () => true)).toBe(false)
  })

  it('on darwin, follows binary presence at /usr/bin/fm', () => {
    const seen: string[] = []
    expect(
      supported('darwin', (p) => {
        seen.push(p)
        return true
      })
    ).toBe(true)
    expect(seen).toEqual([FM_BINARY_PATH])
    expect(supported('darwin', () => false)).toBe(false)
  })
})

describe('disabledByEnv', () => {
  it('only the exact value "1" disables', () => {
    expect(disabledByEnv({ METIS_DISABLE_APPLE_FM: '1' })).toBe(true)
    expect(disabledByEnv({ METIS_DISABLE_APPLE_FM: '0' })).toBe(false)
    expect(disabledByEnv({})).toBe(false)
  })
})

describe('probeAvailability off-platform', () => {
  it('short-circuits to binary-missing without spawning anything when unsupported', async () => {
    // The suite runs on Windows CI too (hermetic contract): on any machine without /usr/bin/fm this must
    // resolve immediately — and on a mac WITH fm it must still never reject.
    const result = await probeAvailability()
    expect(typeof result.available).toBe('boolean')
    if (!supported()) expect(result).toEqual({ available: false, reason: 'binary-missing' })
  })
})

describe('state machine (no child spawned)', () => {
  it('baseURL throws while stopped', () => {
    expect(getState()).toBe('stopped')
    expect(() => baseURL()).toThrow(/not running/)
  })

  it('beginStream/endStream counts and floors at zero', () => {
    expect(activeStreams()).toBe(0)
    beginStream()
    beginStream()
    expect(activeStreams()).toBe(2)
    endStream()
    endStream()
    endStream() // extra release never goes negative
    expect(activeStreams()).toBe(0)
  })

  it('stop() is idempotent from stopped', () => {
    stop()
    stop()
    expect(isRunning()).toBe(false)
    expect(getState()).toBe('stopped')
  })
})

describe('start() integration — real /usr/bin/fm with Apple Intelligence live', () => {
  // Soft-skip: this is the E2E core once Apple Intelligence is enabled on the machine; on Windows CI,
  // macOS 26, or with Apple Intelligence off it degrades to a skip with the reason in the log.
  it(
    'spawns the real fm serve, reaches /health, lists the system model, completes 1 token, stops cleanly',
    async () => {
      if (!supported()) {
        console.warn('[fm-runtime it] skipped — /usr/bin/fm not present on this machine')
        return
      }
      const availability = await probeAvailability(true)
      if (!availability.available) {
        console.warn(`[fm-runtime it] skipped — fm reports unavailable (${availability.reason})`)
        return
      }
      await start()
      try {
        expect(isRunning()).toBe(true)
        const base = new URL(baseURL())
        const health = await fetch(`${base.protocol}//${base.host}/health`)
        expect(health.status).toBe(200)
        const models = (await (await fetch(`${base.protocol}//${base.host}/v1/models`)).json()) as {
          data?: Array<{ id?: string }>
        }
        expect(JSON.stringify(models)).toContain(FM_SYSTEM_MODEL)
        const completion = await fetch(`${base.protocol}//${base.host}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: FM_SYSTEM_MODEL,
            messages: [{ role: 'user', content: 'Reply with one word.' }],
            max_tokens: 8,
            stream: false
          })
        })
        expect(completion.status).toBe(200)
      } finally {
        stop()
      }
      expect(isRunning()).toBe(false)
    },
    120_000
  )
})
