import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hoisted mock for the promisified execFile so every spawn in bootstrap.ts is driven from here —
// no real process is ever launched, no real install ever runs. Mirrors the pattern in cli-win.test.ts.
const h = vi.hoisted(() => ({ execFileImpl: vi.fn() }))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFileImpl
  return { execFile }
})

import {
  runFirstRunBootstrap,
  readBootstrapState,
  parseWhereLines,
  installerStepsForPlatform,
  MAX_LAUNCH_ATTEMPTS,
  type BootstrapLogger
} from './bootstrap'

const REAL_PLATFORM = process.platform

/** process.platform is configurable in Node — flip it for the duration of a platform-specific test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

function makeLog(): BootstrapLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** True when a login-shell probe's args array (`['-lc', '<command>']`) is the given command string. */
function isShellProbe(args: string[], command: string): boolean {
  return Array.isArray(args) && args.includes(command)
}

// ─── Pure helpers — no mocking needed ────────────────────────────────────────────────────────────

describe('parseWhereLines — Windows `where` stdout parsing (probe parsing)', () => {
  it('returns the first line ending in .cmd', () => {
    const out = 'C:\\npm\\graphify.cmd\r\nC:\\npm\\graphify\r\n'
    expect(parseWhereLines(out)).toBe('C:\\npm\\graphify.cmd')
  })

  it('returns the first line ending in .exe when no .cmd/.bat is present', () => {
    expect(parseWhereLines('C:\\Python39\\Scripts\\pip.exe\n')).toBe('C:\\Python39\\Scripts\\pip.exe')
  })

  it('is case-insensitive on the extension', () => {
    expect(parseWhereLines('C:\\npm\\graphify.CMD\n')).toBe('C:\\npm\\graphify.CMD')
  })

  it('skips extension-less shadow entries and picks the launchable one', () => {
    const out = 'C:\\some\\shadow\\graphify\nC:\\npm\\graphify.exe\n'
    expect(parseWhereLines(out)).toBe('C:\\npm\\graphify.exe')
  })

  it('returns null when nothing matches ("not found" output, empty, or extension-less only)', () => {
    expect(parseWhereLines('INFO: Could not find files for the given pattern(s).\n')).toBeNull()
    expect(parseWhereLines('')).toBeNull()
    expect(parseWhereLines('C:\\some\\shadow\\graphify\n')).toBeNull()
  })
})

describe('installerStepsForPlatform — installer order per platform', () => {
  it('darwin/POSIX: uv, then pip3', () => {
    expect(installerStepsForPlatform(false)).toEqual([
      { command: 'uv', args: ['tool', 'install', 'graphifyy'] },
      { command: 'pip3', args: ['install', 'graphifyy'] }
    ])
  })

  it('win32: uv, then `py -m pip`, then pip', () => {
    expect(installerStepsForPlatform(true)).toEqual([
      { command: 'uv', args: ['tool', 'install', 'graphifyy'] },
      { command: 'py', args: ['-m', 'pip', 'install', 'graphifyy'] },
      { command: 'pip', args: ['install', 'graphifyy'] }
    ])
  })
})

// ─── readBootstrapState — file lifecycle ─────────────────────────────────────────────────────────

describe('readBootstrapState — state-file lifecycle', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asktoto-bootstrap-read-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the unknown/zero default when no file exists yet', () => {
    expect(readBootstrapState(dir)).toEqual({
      graphify: 'unknown',
      npm: 'unknown',
      lastAttempt: null,
      attempts: 0,
      error: null
    })
  })

  it('returns the default when the file is corrupt JSON (never throws)', () => {
    writeFileSync(join(dir, 'bootstrap.json'), '{ not valid json')
    expect(readBootstrapState(dir)).toEqual({
      graphify: 'unknown',
      npm: 'unknown',
      lastAttempt: null,
      attempts: 0,
      error: null
    })
  })

  it('sanitizes an unrecognized/malformed field instead of trusting it verbatim', () => {
    writeFileSync(
      join(dir, 'bootstrap.json'),
      JSON.stringify({ graphify: 'yes-please', npm: 42, lastAttempt: 'nope', attempts: -5, error: 7 })
    )
    expect(readBootstrapState(dir)).toEqual({
      graphify: 'unknown',
      npm: 'unknown',
      lastAttempt: null,
      attempts: 0,
      error: null
    })
  })

  it('round-trips a well-formed file untouched', () => {
    const state = { graphify: 'ok' as const, npm: 'missing' as const, lastAttempt: 123, attempts: 2, error: null }
    writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify(state))
    expect(readBootstrapState(dir)).toEqual(state)
  })
})

// ─── runFirstRunBootstrap — darwin/POSIX flow ────────────────────────────────────────────────────

describe('runFirstRunBootstrap — darwin: already installed', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asktoto-bootstrap-mac-'))
    setPlatform('darwin')
    h.execFileImpl.mockReset()
  })
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects an already-installed graphify and never spawns an installer', async () => {
    // Every login-shell probe (npm + graphify) succeeds — nothing to install.
    h.execFileImpl.mockResolvedValue({ stdout: 'found', stderr: '' })
    const log = makeLog()

    await runFirstRunBootstrap({ userDataDir: dir, log })

    const state = readBootstrapState(dir)
    expect(state.graphify).toBe('ok')
    expect(state.npm).toBe('ok')
    expect(state.error).toBeNull()
    expect(state.attempts).toBe(0) // detection-only — no install attempt was spent
    expect(state.lastAttempt).toBeNull()
    // No installer binary (uv/pip3) was ever invoked.
    expect(h.execFileImpl.mock.calls.some((c) => c[0] === 'uv' || c[0] === 'pip3')).toBe(false)
    // The write is atomic: no orphaned .tmp file left behind.
    expect(existsSync(join(dir, 'bootstrap.json.tmp'))).toBe(false)
  })

  it('records npm as missing when the login-shell probe fails, independent of graphify', async () => {
    h.execFileImpl.mockImplementation((_cmd: string, args: string[]) => {
      if (isShellProbe(args, 'command -v npm')) return Promise.reject(new Error('not found'))
      return Promise.resolve({ stdout: 'found', stderr: '' }) // graphify --version succeeds
    })
    const log = makeLog()

    await runFirstRunBootstrap({ userDataDir: dir, log })

    const state = readBootstrapState(dir)
    expect(state.npm).toBe('missing')
    expect(state.graphify).toBe('ok')
  })
})

describe('runFirstRunBootstrap — darwin: installer-order fallback', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asktoto-bootstrap-fallback-'))
    setPlatform('darwin')
    h.execFileImpl.mockReset()
  })
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to pip3 when uv fails, and confirms success via a fresh detection probe', async () => {
    let graphifyInstalled = false
    h.execFileImpl.mockImplementation((cmd: string, args: string[]) => {
      if (isShellProbe(args, 'command -v npm')) return Promise.resolve({ stdout: 'found', stderr: '' })
      if (isShellProbe(args, 'graphify --version')) {
        return graphifyInstalled ? Promise.resolve({ stdout: 'v1', stderr: '' }) : Promise.reject(new Error('not found'))
      }
      if (cmd === 'uv') return Promise.reject(new Error('command not found: uv'))
      if (cmd === 'pip3') {
        graphifyInstalled = true
        return Promise.resolve({ stdout: 'Successfully installed graphifyy', stderr: '' })
      }
      return Promise.reject(new Error(`unexpected spawn: ${cmd}`))
    })
    const log = makeLog()

    await runFirstRunBootstrap({ userDataDir: dir, log })

    const state = readBootstrapState(dir)
    expect(state.graphify).toBe('ok')
    expect(state.error).toBeNull()
    expect(state.attempts).toBe(1)
    expect(state.lastAttempt).not.toBeNull()

    // uv was tried before pip3 (fallback order preserved).
    const uvIdx = h.execFileImpl.mock.calls.findIndex((c) => c[0] === 'uv')
    const pip3Idx = h.execFileImpl.mock.calls.findIndex((c) => c[0] === 'pip3')
    expect(uvIdx).toBeGreaterThanOrEqual(0)
    expect(pip3Idx).toBeGreaterThan(uvIdx)
  })

  it('records the last installer error when every installer fails', async () => {
    h.execFileImpl.mockImplementation((cmd: string, args: string[]) => {
      if (isShellProbe(args, 'command -v npm')) return Promise.resolve({ stdout: 'found', stderr: '' })
      if (isShellProbe(args, 'graphify --version')) return Promise.reject(new Error('not found'))
      if (cmd === 'uv') return Promise.reject(new Error('command not found: uv'))
      if (cmd === 'pip3') return Promise.reject(new Error('pip3: permission denied'))
      return Promise.reject(new Error(`unexpected spawn: ${cmd}`))
    })
    const log = makeLog()

    await runFirstRunBootstrap({ userDataDir: dir, log })

    const state = readBootstrapState(dir)
    expect(state.graphify).toBe('unavailable')
    expect(state.error).toContain('permission denied')
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('runFirstRunBootstrap — retry budget across simulated app launches', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asktoto-bootstrap-budget-'))
    setPlatform('darwin')
    h.execFileImpl.mockReset()
    // Nothing ever succeeds: graphify never detected, both installers always fail.
    h.execFileImpl.mockImplementation((_cmd: string, args: string[]) => {
      if (isShellProbe(args, 'command -v npm')) return Promise.resolve({ stdout: 'found', stderr: '' })
      return Promise.reject(new Error('nope'))
    })
  })
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    rmSync(dir, { recursive: true, force: true })
  })

  it('attempts once per simulated launch, up to MAX_LAUNCH_ATTEMPTS, then stops spawning installers', async () => {
    const log = makeLog()
    const installCallCount = (): number =>
      h.execFileImpl.mock.calls.filter((c) => c[0] === 'uv' || c[0] === 'pip3').length

    for (let launch = 1; launch <= MAX_LAUNCH_ATTEMPTS; launch++) {
      await runFirstRunBootstrap({ userDataDir: dir, log, now: () => 1000 * launch })
      const state = readBootstrapState(dir)
      expect(state.attempts).toBe(launch)
      expect(state.graphify).toBe('unavailable')
      expect(installCallCount()).toBe(launch * 2) // uv + pip3 each launch
    }

    // Budget exhausted — a 4th (and 5th) "launch" must not spawn uv/pip3 again.
    const callsBeforeExtra = installCallCount()
    await runFirstRunBootstrap({ userDataDir: dir, log, now: () => 999_000 })
    await runFirstRunBootstrap({ userDataDir: dir, log, now: () => 999_001 })

    const finalState = readBootstrapState(dir)
    expect(finalState.attempts).toBe(MAX_LAUNCH_ATTEMPTS)
    expect(finalState.lastAttempt).toBe(1000 * MAX_LAUNCH_ATTEMPTS) // unchanged since the last real attempt
    expect(installCallCount()).toBe(callsBeforeExtra)
  })

  it('still re-detects after the budget is exhausted, so an out-of-band manual install is picked up', async () => {
    const log = makeLog()
    for (let launch = 1; launch <= MAX_LAUNCH_ATTEMPTS; launch++) {
      await runFirstRunBootstrap({ userDataDir: dir, log })
    }
    expect(readBootstrapState(dir).graphify).toBe('unavailable')

    // The user (or something else) installed graphify manually between launches.
    h.execFileImpl.mockResolvedValue({ stdout: 'ok', stderr: '' })
    await runFirstRunBootstrap({ userDataDir: dir, log })

    const state = readBootstrapState(dir)
    expect(state.graphify).toBe('ok')
    expect(state.attempts).toBe(MAX_LAUNCH_ATTEMPTS) // budget isn't spent on a pure detection hit
  })
})

// ─── runFirstRunBootstrap — Windows flow (ComSpec routing, no login-shell assumption) ────────────

describe('runFirstRunBootstrap — win32: ComSpec routing for a `.cmd` shim, direct spawn otherwise', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asktoto-bootstrap-win-'))
    setPlatform('win32')
    h.execFileImpl.mockReset()
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
  })
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back uv → py → pip, routes the `.cmd`-resolved pip through ComSpec, and confirms via `where`', async () => {
    let installed = false
    h.execFileImpl.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'where') {
        const target = args[0]
        if (target === 'npm') return Promise.resolve({ stdout: 'C:\\npm\\npm.cmd\n', stderr: '' })
        if (target === 'graphify') {
          return installed
            ? Promise.resolve({ stdout: 'C:\\Python\\Scripts\\graphify.exe\n', stderr: '' })
            : Promise.reject(new Error('where: no matches found'))
        }
        if (target === 'uv') return Promise.reject(new Error('where: no matches found'))
        if (target === 'py') return Promise.resolve({ stdout: 'C:\\Windows\\py.exe\n', stderr: '' })
        if (target === 'pip') return Promise.resolve({ stdout: 'C:\\Python\\Scripts\\pip.cmd\n', stderr: '' })
        return Promise.reject(new Error('where: no matches found'))
      }
      // Bare direct spawns (no `where` hit, or a resolved .exe path invoked directly).
      if (cmd === 'uv') return Promise.reject(new Error('ENOENT: uv not found'))
      if (cmd === 'graphify') return Promise.reject(new Error('not found')) // initial probe, pre-install
      if (cmd === 'C:\\Windows\\py.exe') return Promise.reject(new Error('py: no pip module'))
      if (cmd === 'C:\\Python\\Scripts\\graphify.exe') return Promise.resolve({ stdout: 'v1', stderr: '' })
      // The pip .cmd shim must be routed through ComSpec, never spawned directly.
      if (cmd === 'C:\\Python\\Scripts\\pip.cmd') {
        throw new Error('must not spawn a .cmd shim directly (EINVAL, CVE-2024-27980)')
      }
      if (cmd === 'C:\\Windows\\System32\\cmd.exe') {
        expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
        expect(args[3]).toBe('C:\\Python\\Scripts\\pip.cmd')
        expect(args.slice(4)).toEqual(['install', 'graphifyy'])
        installed = true
        return Promise.resolve({ stdout: 'Successfully installed graphifyy', stderr: '' })
      }
      return Promise.reject(new Error(`unexpected spawn: ${cmd}`))
    })
    const log = makeLog()

    await runFirstRunBootstrap({ userDataDir: dir, log })

    const state = readBootstrapState(dir)
    expect(state.graphify).toBe('ok')
    expect(state.npm).toBe('ok')
    expect(state.error).toBeNull()
  })
})

// ─── Re-entrancy ──────────────────────────────────────────────────────────────────────────────────

describe('runFirstRunBootstrap — re-entrant safety', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asktoto-bootstrap-reentrant-'))
    setPlatform('darwin')
    h.execFileImpl.mockReset()
    h.execFileImpl.mockResolvedValue({ stdout: 'found', stderr: '' })
  })
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    rmSync(dir, { recursive: true, force: true })
  })

  it('two concurrent calls join the same in-flight run instead of racing two writers', async () => {
    const log = makeLog()
    await Promise.all([runFirstRunBootstrap({ userDataDir: dir, log }), runFirstRunBootstrap({ userDataDir: dir, log })])

    // Exactly one detection pass (npm + graphify) — not two.
    expect(h.execFileImpl.mock.calls.length).toBe(2)
    expect(readBootstrapState(dir).graphify).toBe('ok')
  })

  it('never rejects, even on an unexpected internal failure', async () => {
    h.execFileImpl.mockImplementation(() => {
      throw new TypeError('boom — something unforeseen')
    })
    const log = makeLog()
    await expect(runFirstRunBootstrap({ userDataDir: dir, log })).resolves.toBeUndefined()
  })
})
