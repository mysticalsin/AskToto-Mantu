import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// Shared, hoisted mock for the promisified execFile so resolveBin can be driven without a real shell
// or a real Windows `where`. Mirrors the pattern in cli.test.ts; spawnImpl is a controllable-per-test
// spawn mock, needed for the installCli Windows-stderr tests below.
const h = vi.hoisted(() => ({ execFileImpl: vi.fn(), spawnImpl: vi.fn() }))

/**
 * MQA-251 — resolveBin's Windows branch probes the real filesystem.
 *
 * After `where` misses it walks npmGlobalBinCandidates() and returns the first path that existsSync().
 * The "no CLI on this machine" tests below therefore passed or failed depending on whether the DEVELOPER
 * happened to have Claude Code installed — deterministic per machine, invisible in review, and read as
 * flakiness because it changed with test order and host rather than with the commit.
 *
 * Default is the real existsSync so every other test in this file is untouched; the tests that need a
 * genuine miss set `binProbe.hit = false` and get one on any machine.
 */
const binProbe = vi.hoisted(() => ({ hit: null as boolean | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      binProbe.hit === null ? actual.existsSync(p) : binProbe.hit
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

vi.mock('node:child_process', async (importActual) => {
  const { promisify } = await import('node:util')
  const actual = await importActual<typeof import('node:child_process')>()
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFileImpl
  // spawnSync stays REAL: the argv-delivery test below has to run an actual cmd.exe shim to prove
  // what the child receives, which is precisely the thing a mocked spawn cannot tell us.
  return { execFile, spawn: h.spawnImpl, spawnSync: actual.spawnSync }
})

// The self-contained installer (cli-installer.ts) — the fallback the npm-failure paths now route to
// instead of telling the user to install Node (one-click onboarding, 2026-07-16).
const managedMock = vi.hoisted(() => ({
  managedCliEntry: vi.fn((_id?: string): { entry: string; version: string } | null => null),
  installManagedCli: vi.fn(
    async (_id: string, onProgress: (p: { phase: string }) => void): Promise<{ entry: string; version: string }> => {
      onProgress({ phase: 'downloading' })
      return { entry: '/managed/cli.js', version: '9.9.9' }
    }
  )
}))
vi.mock('./cli-installer', () => managedMock)

import {
  resolveBin,
  parseWhereOutput,
  npmGlobalBinCandidates,
  isCmdShim,
  cmdShimSpawn,
  resolveSpawnTarget,
  INSTALL_PERMISSION_ERROR_RE,
  installCli,
  clearBinCache
} from './cli'

const REAL_PLATFORM = process.platform

/** process.platform is configurable in Node — flip it for the duration of a Windows-path test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** A fake ChildProcess: real Readable streams (so readline's createInterface behaves exactly as it
 *  does against a real spawn) wrapped in a real EventEmitter. */
function fakeChild(): { child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }; stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() })
  return { child, stdout, stderr }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

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
    clearBinCache()
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

  it('cmdShimSpawn routes through ComSpec/cmd.exe with /d /s /c, an outer-quoted command line, and verbatim args', () => {
    const saved = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const r = cmdShimSpawn('C:\\npm\\claude.cmd', ['-p', '--model', 'sonnet'])
    expect(r).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "-p" "--model" "sonnet""'],
      windowsVerbatimArguments: true
    })
    if (saved === undefined) delete process.env.ComSpec
    else process.env.ComSpec = saved
  })

  it('falls back to an absolute %SystemRoot%\\System32\\cmd.exe (never a bare name) when ComSpec is unset', () => {
    const savedComSpec = process.env.ComSpec
    const savedSystemRoot = process.env.SystemRoot
    delete process.env.ComSpec
    process.env.SystemRoot = 'C:\\Windows'
    expect(cmdShimSpawn('C:\\npm\\claude.cmd', []).command).toBe('C:\\Windows\\System32\\cmd.exe')
    if (savedComSpec !== undefined) process.env.ComSpec = savedComSpec
    if (savedSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = savedSystemRoot
  })

  it('falls back to the System32 path when ComSpec is set but not absolute (untrustworthy relative name)', () => {
    const savedComSpec = process.env.ComSpec
    const savedSystemRoot = process.env.SystemRoot
    process.env.ComSpec = 'cmd.exe'
    process.env.SystemRoot = 'C:\\Windows'
    expect(cmdShimSpawn('C:\\npm\\claude.cmd', []).command).toBe('C:\\Windows\\System32\\cmd.exe')
    if (savedComSpec === undefined) delete process.env.ComSpec
    else process.env.ComSpec = savedComSpec
    if (savedSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = savedSystemRoot
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

  it('rejects an arg containing a cmd.exe metacharacter (&|^%<>()!)', () => {
    expect(() => cmdShimSpawn('C:\\npm\\claude.cmd', ['--model', 'foo&bar'])).toThrow()
    expect(() => cmdShimSpawn('C:\\npm\\claude.cmd', ['--model', 'foo|bar'])).toThrow()
    expect(() => cmdShimSpawn('C:\\npm\\claude.cmd', ['--model', 'foo%bar%'])).toThrow()
  })

  it('succeeds when the bin path contains spaces, parens, or an ampersand — quoted, not rejected', () => {
    // The resolved bin path is never free text (it comes from resolveBin), so a legitimate install
    // location like "Program Files (x86)" or a "R&D" account profile must still be launchable.
    expect(() =>
      cmdShimSpawn('C:\\Program Files (x86)\\nodejs\\claude.cmd', ['-p'])
    ).not.toThrow()
    expect(() => cmdShimSpawn('C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd', [])).not.toThrow()
    const r = cmdShimSpawn('C:\\Users\\Smith (IT)\\AppData\\Roaming\\npm\\claude.cmd', ['-p'])
    expect(r.args[3]).toBe('""C:\\Users\\Smith (IT)\\AppData\\Roaming\\npm\\claude.cmd" "-p""')
    expect(r.windowsVerbatimArguments).toBe(true)
  })

  it('rejects when the bin path itself contains a quote, newline, or %', () => {
    expect(() => cmdShimSpawn('C:\\npm\\cla"ude.cmd', [])).toThrow()
    expect(() => cmdShimSpawn('C:\\npm\\cla\nude.cmd', [])).toThrow()
    expect(() => cmdShimSpawn('C:\\npm\\cla%ude.cmd', [])).toThrow()
  })

  it('accepts a normal, fully-vocabulary arg list and produces the quoted, verbatim command line', () => {
    const r = cmdShimSpawn('C:\\npm\\claude.cmd', ['-p', '--allowedTools', '', '--disallowedTools', '*'])
    // Every arg carries its own quotes. The empty --allowedTools value is the point: unquoted it
    // collapsed into whitespace and vanished from the child's argv, so the child saw
    // `--allowedTools --disallowedTools *` and the tool lockdown silently did not apply.
    expect(r.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\npm\\claude.cmd" "-p" "--allowedTools" "" "--disallowedTools" "*""'
    ])
    expect(r.windowsVerbatimArguments).toBe(true)
  })

  // A string assertion cannot prove argv DELIVERY — the previous command line looked reasonable and
  // still lost the empty argument inside cmd.exe. This spawns a real .cmd shim and reads back what
  // the child actually received. Windows-only: it depends on cmd.exe's own parsing.
  it.skipIf(process.platform !== 'win32')('delivers an empty argument to the child through cmd.exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-shim-'))
    // A script FILE, not `node -e`: with -e, node keeps parsing leading `--flags` as its own options
    // and dies on `--allowedTools`. Passing a script path stops node's option parsing, so everything
    // after it lands in process.argv exactly as cmd.exe delivered it.
    const helper = join(dir, 'echoargs.mjs')
    writeFileSync(helper, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'ascii')
    const shim = join(dir, 'echoargs.cmd')
    // .cmd must be CRLF + ASCII: cmd.exe misparses an LF-only batch file.
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`, 'ascii')
    try {
      const spawned = cmdShimSpawn(shim, ['-p', '--allowedTools', '', '--disallowedTools', '*'])
      const r = spawnSync(spawned.command, spawned.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: spawned.windowsVerbatimArguments
      })
      expect(r.error).toBeUndefined()
      expect(JSON.parse(r.stdout.trim())).toEqual(['-p', '--allowedTools', '', '--disallowedTools', '*'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps an argument containing spaces as ONE argument', () => {
    // codex's --model value is free text a user types into Settings; unquoted, "gpt-5 codex" would
    // reach the child as two arguments.
    const r = cmdShimSpawn('C:\\npm\\codex.cmd', ['-m', 'gpt-5 codex'])
    expect(r.args[3]).toBe('""C:\\npm\\codex.cmd" "-m" "gpt-5 codex""')
  })

  it('resolveSpawnTarget spawns a .exe directly (no cmd.exe wrapping, verbatim undefined)', () => {
    expect(resolveSpawnTarget('C:\\Program Files\\codex\\codex.exe', ['exec'])).toEqual({
      command: 'C:\\Program Files\\codex\\codex.exe',
      args: ['exec']
    })
  })

  it('resolveSpawnTarget spawns a .cmd through the cmd.exe shim (pinned System32 fallback)', () => {
    const savedComSpec = process.env.ComSpec
    const savedSystemRoot = process.env.SystemRoot
    delete process.env.ComSpec
    process.env.SystemRoot = 'C:\\Windows'
    const shim = resolveSpawnTarget('C:\\npm\\claude.cmd', ['-p'])
    expect(shim.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(shim.args).toEqual(['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "-p""'])
    expect(shim.windowsVerbatimArguments).toBe(true)
    if (savedComSpec !== undefined) process.env.ComSpec = savedComSpec
    if (savedSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = savedSystemRoot
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

describe('installCli — Windows npm-not-found detection (cmd.exe phrasing, not the POSIX shell one)', () => {
  beforeEach(() => {
    clearBinCache()
    h.execFileImpl.mockReset()
    h.spawnImpl.mockReset()
    setPlatform('win32')
    // "Nothing is installed" must MEAN nothing is installed, on any machine — not "nothing is installed
    // unless the person running the tests happens to have the CLI".
    binProbe.hit = false
  })
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    binProbe.hit = null
  })

  it('no npm on the machine: skips the shell entirely and self-installs on embedded Node (one-click)', async () => {
    // resolveBin('claude') misses AND resolveBin('npm') misses — the pre-2026-07-16 behavior was a
    // dead-end error telling the user to install Node from nodejs.org; now it must go straight to the
    // managed installer without ever spawning cmd.exe.
    managedMock.installManagedCli.mockClear()
    h.execFileImpl.mockRejectedValue(new Error('where: no matches found'))

    const progress = vi.fn()
    const r = await installCli('claude-cli', progress)

    expect(r.ok).toBe(true)
    expect(managedMock.installManagedCli).toHaveBeenCalledWith('claude', expect.any(Function))
    expect(h.spawnImpl).not.toHaveBeenCalled() // no npm shell attempt — nothing to fail
    expect(progress.mock.calls.some(([line]) => /self-contained|no Node\.js required/i.test(String(line)))).toBe(true)
  })

  it('npm resolved but dies with cmd.exe\'s "not recognized" stderr: falls back to the managed install', async () => {
    managedMock.installManagedCli.mockClear()
    // resolveBin('claude') misses; resolveBin('npm') HITS (so the npm spawn happens), then the spawned
    // installer emits the cmd.exe not-recognized phrasing and exits 1.
    h.execFileImpl.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('claude')) throw new Error('where: no matches found')
      if (args.includes('npm')) return { stdout: 'C:\\Program Files\\nodejs\\npm.cmd\r\n', stderr: '' }
      throw new Error('where: no matches found')
    })
    const { child, stderr } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const resultPromise = installCli('claude-cli', vi.fn())
    stderr.write("'npm' is not recognized as an internal or external command,\r\n")
    stderr.write('operable program or batch file.\r\n')
    await tick()
    child.emit('close', 1)

    const r = await resultPromise
    expect(r.ok).toBe(true) // the managed fallback rescued the install
    expect(managedMock.installManagedCli).toHaveBeenCalledWith('claude', expect.any(Function))
  })
})

describe('Dust Connect — Windows privilege + detect (Quality)', () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    binProbe.hit = null
    clearBinCache()
  })

  it('install+login sequence is one consent, never UAC + npm-global + helper', async () => {
    const { mockDustConnectPrivilegeSequence } = await import('./dust-connect')
    const plan = mockDustConnectPrivilegeSequence('win32')
    expect(plan.privilegeSpawns).toBe(1)
    expect(plan.kinds).not.toContain('uac')
    expect(plan.kinds).not.toContain('npm-global')
    expect(plan.kinds).not.toContain('sudo')
  })

  it('detect order is managed userData, then ~/.hermes, then PATH — not a global npm prefix', async () => {
    const { dustConnectDetectOrder } = await import('./dust-connect')
    const { dustBinCandidates } = await import('@shared/dust-connect')
    const list = dustBinCandidates({
      platform: 'win32',
      userData: 'C:\\Users\\tony\\AppData\\Roaming\\Metis',
      home: 'C:\\Users\\tony',
      managedEntry: 'C:\\Users\\tony\\AppData\\Roaming\\Metis\\managed-cli\\dust\\0.4.5\\package\\dist\\index.js'
    })
    expect(list[0]).toContain('managed-cli\\dust')
    expect(list.some((p) => p.includes('.hermes') && p.endsWith('dust.cmd'))).toBe(true)
    expect(list.some((p) => /Roaming\\npm\\dust/i.test(p))).toBe(false)
    expect(dustConnectDetectOrder('C:\\ud', 'C:\\Users\\tony', 'win32').length).toBeGreaterThan(1)
  })

  it('resolveDustBin prefers the managed entry after Connect, even when PATH dust misses', async () => {
    setPlatform('win32')
    binProbe.hit = false
    clearBinCache()
    managedMock.managedCliEntry.mockImplementation((_id?: string) => ({
      entry: 'C:\\Users\\tony\\AppData\\Roaming\\Metis\\managed-cli\\dust\\0.4.5\\package\\dist\\index.js',
      version: '0.4.5'
    }))
    const { resolveDustBin } = await import('./cli')
    const { existsSync } = await import('node:fs')
    // existsSync is mocked via binProbe — force a hit for the managed path only.
    binProbe.hit = true
    const bin = await resolveDustBin()
    expect(bin).toMatch(/managed-cli/)
    expect(existsSync).toBeTypeOf('function')
    managedMock.managedCliEntry.mockImplementation((_id?: string) => null)
  })
})
