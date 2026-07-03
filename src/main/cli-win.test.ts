import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared, hoisted mock for the promisified execFile so resolveBin can be driven without a real shell
// or a real Windows `where`. Mirrors the pattern in cli.test.ts.
const h = vi.hoisted(() => ({ execFileImpl: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFileImpl
  const spawn = vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
  return { execFile, spawn }
})

import {
  resolveBin,
  parseWhereOutput,
  npmGlobalBinCandidates,
  isCmdShim,
  cmdShimSpawn,
  resolveSpawnTarget,
  INSTALL_PERMISSION_ERROR_RE
} from './cli'

const REAL_PLATFORM = process.platform

/** process.platform is configurable in Node — flip it for the duration of a Windows-path test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('parseWhereOutput — Windows `where` stdout parsing', () => {
  it('returns the first line ending in .cmd', () => {
    const out = 'C:\\Users\\tony\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\tony\\AppData\\Roaming\\npm\\claude\r\n'
    expect(parseWhereOutput(out)).toBe('C:\\Users\\tony\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('returns the first line ending in .exe when no .cmd is present', () => {
    const out = 'C:\\Program Files\\codex\\codex.exe\n'
    expect(parseWhereOutput(out)).toBe('C:\\Program Files\\codex\\codex.exe')
  })

  it('is case-insensitive on the extension', () => {
    expect(parseWhereOutput('C:\\npm\\claude.CMD\n')).toBe('C:\\npm\\claude.CMD')
  })

  it('skips extension-less shadow entries and picks the launchable one', () => {
    const out = 'C:\\some\\shadow\\claude\nC:\\Users\\tony\\AppData\\Roaming\\npm\\claude.cmd\n'
    expect(parseWhereOutput(out)).toBe('C:\\Users\\tony\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('returns null when nothing matches (where found nothing, or only extension-less hits)', () => {
    expect(parseWhereOutput('INFO: Could not find files for the given pattern(s).\n')).toBeNull()
    expect(parseWhereOutput('')).toBeNull()
    expect(parseWhereOutput('C:\\some\\shadow\\claude\n')).toBeNull()
  })
})

describe('npmGlobalBinCandidates — Windows npm global-bin fallback paths', () => {
  const savedAppData = process.env.APPDATA
  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  })

  it('builds .cmd and .exe candidates under %APPDATA%\\npm', () => {
    process.env.APPDATA = 'C:\\Users\\tony\\AppData\\Roaming'
    expect(npmGlobalBinCandidates('claude')).toEqual([
      join('C:\\Users\\tony\\AppData\\Roaming', 'npm', 'claude.cmd'),
      join('C:\\Users\\tony\\AppData\\Roaming', 'npm', 'claude.exe')
    ])
  })

  it('returns no candidates when APPDATA is unset', () => {
    delete process.env.APPDATA
    expect(npmGlobalBinCandidates('claude')).toEqual([])
  })
})

describe('resolveBin — Windows: `where` first, then a real-fs APPDATA probe fallback', () => {
  let tmpDir: string
  const savedAppData = process.env.APPDATA

  beforeEach(() => {
    h.execFileImpl.mockReset()
    tmpDir = mkdtempSync(join(tmpdir(), 'asktoto-cliwin-'))
    setPlatform('win32')
  })

  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    rmSync(tmpDir, { recursive: true, force: true })
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  })

  it('resolves via `where` when it finds a .cmd/.exe hit', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: 'C:\\npm\\wherehit-tool.cmd\r\n', stderr: '' })
    expect(await resolveBin('wherehit-tool')).toBe('C:\\npm\\wherehit-tool.cmd')
  })

  it('falls back to the APPDATA npm probe when `where` fails (stale PATH right after an install)', async () => {
    h.execFileImpl.mockRejectedValue(new Error('where: no matches found')) // `where` exits non-zero
    process.env.APPDATA = tmpDir
    const npmDir = join(tmpDir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'appdata-tool.cmd'), '')

    expect(await resolveBin('appdata-tool')).toBe(join(npmDir, 'appdata-tool.cmd'))
  })

  it('falls back to the .exe candidate when only the .exe fixture exists', async () => {
    h.execFileImpl.mockRejectedValue(new Error('where: no matches found'))
    process.env.APPDATA = tmpDir
    const npmDir = join(tmpDir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'exe-tool.exe'), '')

    expect(await resolveBin('exe-tool')).toBe(join(npmDir, 'exe-tool.exe'))
  })

  it('returns null when both `where` and the APPDATA probe miss', async () => {
    h.execFileImpl.mockRejectedValue(new Error('where: no matches found'))
    process.env.APPDATA = tmpDir // empty dir, no npm subfolder at all

    expect(await resolveBin('totally-missing-tool')).toBeNull()
  })

  it('caches a positive `where` hit (no second shell-out)', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: 'C:\\npm\\cached-tool.cmd\n', stderr: '' })
    const a = await resolveBin('cached-tool')
    const b = await resolveBin('cached-tool')
    expect(a).toBe('C:\\npm\\cached-tool.cmd')
    expect(b).toBe('C:\\npm\\cached-tool.cmd')
    expect(h.execFileImpl).toHaveBeenCalledTimes(1)
  })
})

describe('isCmdShim / cmdShimSpawn / resolveSpawnTarget — Windows shim launch (CVE-2024-27980 workaround)', () => {
  it('isCmdShim is true only for .cmd paths (case-insensitive), false for .exe or unix paths', () => {
    expect(isCmdShim('C:\\npm\\claude.cmd')).toBe(true)
    expect(isCmdShim('C:\\npm\\claude.CMD')).toBe(true)
    expect(isCmdShim('C:\\Program Files\\codex\\codex.exe')).toBe(false)
    expect(isCmdShim('/usr/local/bin/claude')).toBe(false)
  })

  it('cmdShimSpawn routes through ComSpec/cmd.exe with /d /s /c and preserves arg order', () => {
    const saved = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const r = cmdShimSpawn('C:\\npm\\claude.cmd', ['-p', '--model', 'sonnet'])
    expect(r).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\npm\\claude.cmd', '-p', '--model', 'sonnet']
    })
    if (saved === undefined) delete process.env.ComSpec
    else process.env.ComSpec = saved
  })

  it('falls back to the literal "cmd.exe" when ComSpec is unset', () => {
    const saved = process.env.ComSpec
    delete process.env.ComSpec
    expect(cmdShimSpawn('C:\\npm\\claude.cmd', []).command).toBe('cmd.exe')
    if (saved !== undefined) process.env.ComSpec = saved
  })

  it('rejects an arg containing a double-quote (cmd.exe argv-injection guard)', () => {
    expect(() => cmdShimSpawn('C:\\npm\\claude.cmd', ['--model', 'evil" & calc.exe & "'])).toThrow()
  })

  it('rejects an arg containing a newline', () => {
    expect(() => cmdShimSpawn('C:\\npm\\claude.cmd', ['--model', 'line1\nline2'])).toThrow()
  })

  it('rejects a carriage return too', () => {
    expect(() => cmdShimSpawn('C:\\npm\\claude.cmd', ['--model', 'line1\rline2'])).toThrow()
  })

  it('rejects when the bin path itself is unsafe', () => {
    expect(() => cmdShimSpawn('C:\\npm\\cla"ude.cmd', [])).toThrow()
  })

  it('accepts a normal, fully-vocabulary arg list untouched', () => {
    const r = cmdShimSpawn('C:\\npm\\claude.cmd', ['-p', '--allowedTools', '', '--disallowedTools', '*'])
    expect(r.args).toEqual(['/d', '/s', '/c', 'C:\\npm\\claude.cmd', '-p', '--allowedTools', '', '--disallowedTools', '*'])
  })

  it('resolveSpawnTarget spawns a .exe directly (no cmd.exe wrapping)', () => {
    expect(resolveSpawnTarget('C:\\Program Files\\codex\\codex.exe', ['exec'])).toEqual({
      command: 'C:\\Program Files\\codex\\codex.exe',
      args: ['exec']
    })
  })

  it('resolveSpawnTarget spawns a .cmd through the cmd.exe shim', () => {
    const shim = resolveSpawnTarget('C:\\npm\\claude.cmd', ['-p'])
    expect(shim.command).toBe(process.env.ComSpec || 'cmd.exe')
    expect(shim.args).toEqual(['/d', '/s', '/c', 'C:\\npm\\claude.cmd', '-p'])
  })

  it('resolveSpawnTarget leaves a plain unix bin untouched (mac/Linux path stays byte-identical)', () => {
    expect(resolveSpawnTarget('/usr/local/bin/claude', ['-p', '--model', 'opus'])).toEqual({
      command: '/usr/local/bin/claude',
      args: ['-p', '--model', 'opus']
    })
  })
})

describe('INSTALL_PERMISSION_ERROR_RE — routes global-install failures to the Terminal/console fallback', () => {
  it('matches mac/Linux EACCES', () => {
    expect(INSTALL_PERMISSION_ERROR_RE.test('Error: EACCES: permission denied, mkdir \'/usr/local/lib\'')).toBe(true)
  })

  it('matches Windows EPERM', () => {
    expect(INSTALL_PERMISSION_ERROR_RE.test('npm error EPERM: operation not permitted, rename ...')).toBe(true)
  })

  it('matches generic permission-denied / not-permitted phrasing', () => {
    expect(INSTALL_PERMISSION_ERROR_RE.test('permission denied')).toBe(true)
    expect(INSTALL_PERMISSION_ERROR_RE.test('operation not permitted')).toBe(true)
  })

  it('does not match unrelated npm errors', () => {
    expect(
      INSTALL_PERMISSION_ERROR_RE.test('npm error 404 Not Found - GET https://registry.npmjs.org/@foo%2fbar')
    ).toBe(false)
    expect(INSTALL_PERMISSION_ERROR_RE.test('command not found: npm')).toBe(false)
  })
})
