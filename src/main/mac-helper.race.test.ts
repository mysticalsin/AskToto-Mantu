/**
 * Regression lock for the 'close'-vs-'exit' stdout race in extractScreenText (review fix, 2026-07-16):
 * Node can fire a child's 'exit' while piped stdout still has undelivered chunks; settling there
 * truncates a dense screen's tens-of-KB OCR JSON and silently kills the OCR path. 'close' guarantees
 * all stdio has drained. These tests emit JSON in two halves AROUND the 'exit' event — a regression back
 * to settling on 'exit' fails the positive case.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: () => true }
})
const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock.spawn }))

import { extractScreenText } from './mac-helper'

// macHelperPresent() requires darwin — pin it so this suite is deterministic on Windows CI too.
const realPlatform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

type FakeProc = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { on: () => void; end: () => void }
  killed: boolean
  kill: () => void
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { on: () => {}, end: () => {} }
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
  }
  return proc
}

// Long lines so buildOcrContext clears its text-poor floor (40 chars).
const OCR_JSON = JSON.stringify({
  width: 1280,
  height: 800,
  lines: [
    { text: 'quarterly pipeline review with the enterprise accounts team', confidence: 0.99, box: [0.1, 0.9, 0.5, 0.02] },
    { text: 'decision: move the Cahe pilot to general availability in Q4', confidence: 0.98, box: [0.1, 0.5, 0.5, 0.02] }
  ]
})

describe('extractScreenText stdio drain (close vs exit)', () => {
  it('includes stdout chunks that arrive AFTER exit but before close', async () => {
    const proc = fakeProc()
    spawnMock.spawn.mockReturnValue(proc)
    const pending = extractScreenText('aW1n')
    const half = Math.floor(OCR_JSON.length / 2)
    proc.stdout.emit('data', Buffer.from(OCR_JSON.slice(0, half)))
    proc.emit('exit', 0, null) // exit fires first — the old wiring settled (and truncated) here
    proc.stdout.emit('data', Buffer.from(OCR_JSON.slice(half)))
    proc.emit('close', 0)
    const result = await pending
    expect(result).not.toBeNull()
    expect(result).toContain('quarterly pipeline review')
    expect(result).toContain('Cahe pilot')
  })

  it("negative control: closing after only half the JSON yields null (the race isn't masked)", async () => {
    const proc = fakeProc()
    spawnMock.spawn.mockReturnValue(proc)
    const pending = extractScreenText('aW1n')
    proc.stdout.emit('data', Buffer.from(OCR_JSON.slice(0, 40)))
    proc.emit('exit', 0, null)
    proc.emit('close', 0)
    await expect(pending).resolves.toBeNull()
  })
})
