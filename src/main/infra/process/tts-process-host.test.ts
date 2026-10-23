import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  createTtsProcessHost,
  MAX_TTS_STDIN_CHARS,
  TTS_FORCE_KILL_AFTER_MS,
  type TtsChild,
  type TtsProcessSpec
} from './tts-process-host'

class FakeChild extends EventEmitter implements TtsChild {
  readonly stdout = new PassThrough()
  readonly stdin = new PassThrough()
  readonly written: string[] = []
  signals: Array<string | undefined> = []
  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk.toString('utf8')))
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return true
  }
}

function clock() {
  const timers: Array<{ id: number; at: number; run: () => void; cleared: boolean }> = []
  let now = 0
  let next = 1
  return {
    setTimeout: (run: () => void, ms: number) => {
      const timer = { id: next++, at: now + ms, run, cleared: false }
      timers.push(timer)
      return timer as unknown as NodeJS.Timeout
    },
    clearTimeout: (handle: NodeJS.Timeout) => {
      ;(handle as unknown as { cleared: boolean }).cleared = true
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers) if (!timer.cleared && timer.at <= now) (timer.cleared = true), timer.run()
    }
  }
}

const SPEC: TtsProcessSpec = {
  command: '/synthetic/helper',
  args: ['speak', '--rate', '1'],
  env: { METIS_TTS_VOICE: 'Synthetic Voice' },
  stdin: 'Hello there'
}

function harness() {
  const child = new FakeChild()
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const time = clock()
  const host = createTtsProcessHost({
    spawn: (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> })
      return child
    },
    baseEnv: { PATH: '/synthetic/bin' },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout
  })
  return { child, calls, host, time }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('createTtsProcessHost (G27)', () => {
  it('spawns the argv directly with no shell, a hidden window, a stdin pipe and the voice values in the environment', () => {
    const { calls, host } = harness()
    host.start(SPEC, { onLine: () => {}, onExit: () => {} })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/synthetic/helper')
    expect(calls[0].args).toEqual(['speak', '--rate', '1'])
    expect(calls[0].options).toMatchObject({ windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    expect(calls[0].options.shell).not.toBe(true)
    expect(calls[0].options.env).toEqual({ PATH: '/synthetic/bin', METIS_TTS_VOICE: 'Synthetic Voice' })
  })

  it('writes the text to stdin and closes it; the text is never in argv', async () => {
    const { child, calls, host } = harness()
    host.start({ ...SPEC, stdin: 'Réponse: "ça va"; $(touch x)' }, { onLine: () => {}, onExit: () => {} })
    await tick()
    expect(child.written.join('')).toBe('Réponse: "ça va"; $(touch x)')
    expect(child.stdin.writableEnded).toBe(true)
    expect(JSON.stringify(calls[0].args)).not.toContain('touch')
  })

  it('refuses text over the bound instead of writing it', () => {
    const { calls, host } = harness()
    const exits: unknown[] = []
    host.start(
      { ...SPEC, stdin: 'x'.repeat(MAX_TTS_STDIN_CHARS + 1) },
      { onLine: () => {}, onExit: (info) => exits.push(info) }
    )
    expect(calls).toHaveLength(0)
    expect(exits).toEqual([{ code: null, signal: null, error: 'text_too_long' }])
  })

  it('reassembles stdout lines across chunks', async () => {
    const { child, host } = harness()
    const lines: string[] = []
    host.start(SPEC, { onLine: (line) => lines.push(line), onExit: () => {} })
    child.stdout.write('start')
    child.stdout.write('ed\r\nend')
    child.stdout.write('ed\n')
    await tick()
    expect(lines).toEqual(['started', 'ended'])
  })

  it('reports the exit once, and a spawn error as an exit with the message', () => {
    const { child, host } = harness()
    const exits: unknown[] = []
    host.start(SPEC, { onLine: () => {}, onExit: (info) => exits.push(info) })
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    expect(exits).toEqual([{ code: 0, signal: null }])
    const second = harness()
    const errors: unknown[] = []
    second.host.start(SPEC, { onLine: () => {}, onExit: (info) => errors.push(info) })
    second.child.emit('error', new Error('spawn ENOENT'))
    expect(errors).toEqual([{ code: null, signal: null, error: 'spawn ENOENT' }])
  })

  it('a spawn that throws is an exit with the message, not an exception', () => {
    const host = createTtsProcessHost({
      spawn: () => {
        throw new Error('EACCES')
      }
    })
    const exits: unknown[] = []
    const handle = host.start(SPEC, { onLine: () => {}, onExit: (info) => exits.push(info) })
    expect(exits).toEqual([{ code: null, signal: null, error: 'EACCES' }])
    expect(() => handle.kill()).not.toThrow()
  })

  it('kill is immediate (SIGTERM), idempotent, silences later callbacks and forces SIGKILL after the bound', async () => {
    const { child, host, time } = harness()
    const lines: string[] = []
    const exits: unknown[] = []
    const handle = host.start(SPEC, { onLine: (l) => lines.push(l), onExit: (i) => exits.push(i) })
    handle.kill()
    handle.kill()
    expect(child.signals).toEqual(['SIGTERM'])
    child.stdout.write('started\n')
    child.emit('exit', null, 'SIGTERM')
    await tick()
    expect(lines).toEqual([])
    expect(exits).toEqual([])
    // exited, so the force kill never fires
    time.advance(TTS_FORCE_KILL_AFTER_MS + 1)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('forces SIGKILL when the child has not exited within the bound', () => {
    const { child, host, time } = harness()
    const handle = host.start(SPEC, { onLine: () => {}, onExit: () => {} })
    handle.kill()
    time.advance(TTS_FORCE_KILL_AFTER_MS - 1)
    expect(child.signals).toEqual(['SIGTERM'])
    time.advance(2)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('keeps SIGKILL armed after a TERM error without close, and cancels it after a real close', () => {
    const errored = harness()
    const handle = errored.host.start(SPEC, { onLine: () => {}, onExit: () => {} })
    handle.kill()
    errored.child.emit('error', new Error('signal delivery failed'))
    errored.time.advance(TTS_FORCE_KILL_AFTER_MS + 1)
    expect(errored.child.signals).toEqual(['SIGTERM', 'SIGKILL'])

    const closed = harness()
    const closedHandle = closed.host.start(SPEC, { onLine: () => {}, onExit: () => {} })
    closedHandle.kill()
    closed.child.emit('close', null, 'SIGTERM')
    closed.time.advance(TTS_FORCE_KILL_AFTER_MS + 1)
    expect(closed.child.signals).toEqual(['SIGTERM'])
  })

  it('a stdin pipe error (the child is already gone) is swallowed', async () => {
    const { child, host } = harness()
    host.start(SPEC, { onLine: () => {}, onExit: () => {} })
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
  })
})

describe('createTtsProcessHost probe (G27)', () => {
  it('collects stdout of a one-shot and reports ok on exit 0', async () => {
    const { child, host } = harness()
    const result = host.probe({ ...SPEC, stdin: '' }, 5000)
    child.stdout.write('{"voices":[]}')
    child.emit('close', 0, null)
    await expect(result).resolves.toEqual({ ok: true, stdout: '{"voices":[]}' })
  })

  it('reports not ok on a non-zero exit, on a spawn error and on timeout (and kills the child)', async () => {
    const failed = harness()
    const a = failed.host.probe(SPEC, 5000)
    failed.child.emit('close', 1, null)
    await expect(a).resolves.toMatchObject({ ok: false })

    const broken = harness()
    const b = broken.host.probe(SPEC, 5000)
    broken.child.emit('error', new Error('spawn ENOENT'))
    await expect(b).resolves.toMatchObject({ ok: false })

    const slow = harness()
    const c = slow.host.probe(SPEC, 5000)
    slow.time.advance(5001)
    await expect(c).resolves.toMatchObject({ ok: false })
    expect(slow.child.signals[0]).toBe('SIGTERM')
    slow.time.advance(TTS_FORCE_KILL_AFTER_MS + 1)
    expect(slow.child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('keeps the force-kill armed after an error without close, and cancels it after a real close', async () => {
    const errored = harness()
    let resultCount = 0
    const result = errored.host.probe(SPEC, 5000).then((value) => {
      resultCount += 1
      return value
    })
    errored.time.advance(5001)
    await expect(result).resolves.toMatchObject({ ok: false })
    errored.child.emit('error', new Error('child error without close'))
    errored.time.advance(TTS_FORCE_KILL_AFTER_MS + 1)
    expect(errored.child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(resultCount).toBe(1)

    const closed = harness()
    const closedResult = closed.host.probe(SPEC, 5000)
    closed.time.advance(5001)
    await expect(closedResult).resolves.toMatchObject({ ok: false })
    closed.time.advance(100)
    closed.child.emit('close', null, 'SIGTERM')
    closed.time.advance(TTS_FORCE_KILL_AFTER_MS)
    expect(closed.child.signals).toEqual(['SIGTERM'])
  })

  it('bounds the collected output', async () => {
    const { child, host } = harness()
    const result = host.probe(SPEC, 5000)
    child.stdout.write('x'.repeat(200_000))
    child.emit('close', 0, null)
    const { stdout } = await result
    expect(stdout.length).toBeLessThanOrEqual(128 * 1024)
  })
})
