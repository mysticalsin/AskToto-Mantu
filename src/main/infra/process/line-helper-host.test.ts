import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MAX_HELPER_LINE_CHARS, spawnLineHelper, type LineHelperChild } from './line-helper-host'

class FakeChild extends EventEmitter implements LineHelperChild {
  readonly stdout = new PassThrough()
  killed = 0
  kill(): boolean {
    this.killed += 1
    return true
  }
}

function harness() {
  const child = new FakeChild()
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const lines: string[] = []
  const exits: Array<{ code: number | null; signal: string | null; error?: string }> = []
  const handle = spawnLineHelper(
    { command: '/synthetic/helper', args: ['watch-modifiers', '--interval-ms', '40'] },
    { onLine: (line) => lines.push(line), onExit: (info) => exits.push(info) },
    {
      spawn: (command, args, options) => {
        calls.push({ command, args, options: options as Record<string, unknown> })
        return child
      }
    }
  )
  return { child, calls, lines, exits, handle }
}

describe('spawnLineHelper', () => {
  it('spawns the argv directly with no shell, a hidden window and no stdin or stderr pipe', () => {
    const { calls } = harness()
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/synthetic/helper')
    expect(calls[0].args).toEqual(['watch-modifiers', '--interval-ms', '40'])
    expect(calls[0].options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    expect(calls[0].options.shell).not.toBe(true)
  })

  it('reassembles lines across chunks and strips LF and CRLF', async () => {
    const { child, lines } = harness()
    child.stdout.write('m 32 ')
    child.stdout.write('0\nm 0 ')
    child.stdout.write('0\r\nm 2 1\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(lines).toEqual(['m 32 0', 'm 0 0', 'm 2 1'])
  })

  it('discards an over-long line instead of buffering it without bound, then recovers', async () => {
    const { child, lines } = harness()
    child.stdout.write('x'.repeat(MAX_HELPER_LINE_CHARS * 5))
    child.stdout.write('x'.repeat(MAX_HELPER_LINE_CHARS * 5))
    child.stdout.write('\nm 1 2\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(lines).toEqual(['m 1 2'])
  })

  it('reports an exit exactly once', () => {
    const { child, exits } = harness()
    child.emit('exit', 1, null)
    child.emit('close', 1, null)
    expect(exits).toEqual([{ code: 1, signal: null }])
  })

  it('reports a spawn error (where Node never emits exit) once, with its message', () => {
    const { child, exits } = harness()
    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', null, null)
    expect(exits).toEqual([{ code: null, signal: null, error: 'spawn ENOENT' }])
  })

  it('kill is idempotent, signals the child once, and silences every later callback', async () => {
    const { child, handle, lines, exits } = harness()
    handle.kill()
    handle.kill()
    expect(child.killed).toBe(1)
    child.stdout.write('m 1 1\n')
    child.emit('exit', null, 'SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))
    expect(lines).toEqual([])
    expect(exits).toEqual([])
  })

  it('lets a failing spawn propagate to the caller (the watcher owns the restart policy)', () => {
    expect(() =>
      spawnLineHelper(
        { command: '/synthetic/helper', args: [] },
        { onLine: () => undefined, onExit: () => undefined },
        {
          spawn: () => {
            throw new Error('EACCES')
          }
        }
      )
    ).toThrow('EACCES')
  })

  it('a throwing line handler cannot break the stream', async () => {
    const child = new FakeChild()
    const seen: string[] = []
    spawnLineHelper(
      { command: '/synthetic/helper', args: [] },
      {
        onLine: (line) => {
          seen.push(line)
          if (line === 'boom') throw new Error('handler failed')
        },
        onExit: () => undefined
      },
      { spawn: () => child }
    )
    child.stdout.write('boom\nm 1 1\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual(['boom', 'm 1 1'])
  })
})
