import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn as SpawnFn, spawnSync as SpawnSyncFn } from 'node:child_process'

// The temp dir the app writes its setup/login script into. Hoisted so the electron mock (which is
// itself hoisted above the imports) can read it lazily, once beforeAll has created the real dir.
const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  shell: { openPath: vi.fn(async () => '') }
}))

// The self-contained installer is irrelevant here but is imported by cli.ts at module load.
vi.mock('./cli-installer', () => ({
  managedCliEntry: vi.fn(() => null),
  managedCliCommand: vi.fn(() => null),
  installManagedCli: vi.fn()
}))

// RF-AUDIT-R3-B1's own tests (below) need to see and, for one real behaviour test, actually run the
// exact { command, args, options } openCliScript hands to spawn() — a mocked spawn cannot tell us
// whether cmd.exe would still split an unquoted `&` into a second command. Every OTHER test in this
// file must keep spawning for real exactly as it did before this mock existed (real success on a
// genuine Windows host, a harmless real ENOENT everywhere else, already tolerated by openCliScript's
// own fallback to shell.openPath) — so the default implementation below simply delegates to the real
// spawn, and only the RF-AUDIT-R3-B1 tests override it per-call.
const spawnH = vi.hoisted(() => ({
  impl: vi.fn(),
  real: null as typeof SpawnFn | null,
  realSync: null as typeof SpawnSyncFn | null
}))
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>()
  spawnH.real = actual.spawn
  spawnH.realSync = actual.spawnSync
  return { ...actual, spawn: spawnH.impl }
})

import { setupCli, loginCli, loginCliInvokeLines, cmdShimSpawn } from './cli'

const REAL_PLATFORM = process.platform

/** process.platform is configurable in Node — flip it for the duration of a per-OS script test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** Run a script-writing action and return the file it created (name + raw bytes decoded as UTF-8). */
async function capture(run: () => Promise<{ ok: boolean; error?: string }>): Promise<{ name: string; text: string }> {
  const before = new Set(readdirSync(h.dir))
  const res = await run()
  expect(res).toEqual({ ok: true })
  const created = readdirSync(h.dir).filter((f) => !before.has(f))
  expect(created).toHaveLength(1)
  const name = created[0]!
  return { name, text: readFileSync(join(h.dir, name), 'utf8') }
}

const LONE_LF = /(?<!\r)\n/
const NON_ASCII = /[^\x00-\x7F]/

beforeAll(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'asktoto-cli-script-'))
})
afterAll(() => {
  setPlatform(REAL_PLATFORM)
  rmSync(h.dir, { recursive: true, force: true })
})
beforeEach(() => {
  // See the mock's own comment: every test outside the RF-AUDIT-R3-B1 describe block below relies on
  // spawn behaving exactly as it did with no mock at all, so this default is (re-)applied before every
  // test, and only the RF-AUDIT-R3-B1 tests install their own one-off override on top of it.
  spawnH.impl.mockReset()
  spawnH.impl.mockImplementation((...args: Parameters<typeof SpawnFn>) => spawnH.real!(...args))
})
afterEach(() => {
  setPlatform(REAL_PLATFORM)
})

describe('setupCli / loginCli — Windows .cmd scripts must be CRLF and ASCII-only', () => {
  // cmd.exe misparses an LF-only batch file: multi-line `if errorlevel 1 ( … )` blocks and trailing
  // commands are dropped. Non-ASCII text renders as mojibake under the OEM console codepage.
  for (const provider of ['claude-cli', 'codex-cli'] as const) {
    it(`setupCli(${provider}) writes a .cmd with CRLF line endings only`, async () => {
      setPlatform('win32')
      const { name, text } = await capture(() => setupCli(provider))
      expect(name.endsWith('.cmd')).toBe(true)
      expect(LONE_LF.test(text)).toBe(false)
      expect(text.endsWith('\r\n')).toBe(true)
    })

    it(`setupCli(${provider}) writes a .cmd body with no non-ASCII characters`, async () => {
      setPlatform('win32')
      const { text } = await capture(() => setupCli(provider))
      expect(text.match(NON_ASCII)).toBeNull()
    })

    it(`loginCli(${provider}) writes a .cmd with CRLF line endings and no non-ASCII characters`, async () => {
      setPlatform('win32')
      const { name, text } = await capture(() => loginCli(provider))
      expect(name.endsWith('.cmd')).toBe(true)
      expect(LONE_LF.test(text)).toBe(false)
      expect(text.endsWith('\r\n')).toBe(true)
      expect(text.match(NON_ASCII)).toBeNull()
    })

    it(`setupCli(${provider}) keeps every errorlevel block closed on its own line`, async () => {
      setPlatform('win32')
      const { text } = await capture(() => setupCli(provider))
      const lines = text.split('\r\n')
      expect(lines.filter((l) => l === 'if errorlevel 1 (').length).toBe(2)
      expect(lines.filter((l) => l === ')').length).toBe(2)
    })
  }
})

describe('setupCli / loginCli — POSIX .command scripts stay LF', () => {
  for (const provider of ['claude-cli', 'codex-cli'] as const) {
    it(`setupCli(${provider}) writes a .command with LF line endings only`, async () => {
      setPlatform('darwin')
      const { name, text } = await capture(() => setupCli(provider))
      expect(name.endsWith('.command')).toBe(true)
      expect(text).toContain('\n')
      expect(text).not.toContain('\r')
      expect(text.endsWith('\n')).toBe(true)
      expect(text.startsWith('#!/bin/bash\n')).toBe(true)
    })

    it(`loginCli(${provider}) writes a .command with LF line endings only`, async () => {
      setPlatform('darwin')
      const { name, text } = await capture(() => loginCli(provider))
      expect(name.endsWith('.command')).toBe(true)
      expect(text).not.toContain('\r')
      expect(text.endsWith('\n')).toBe(true)
    })
  }
})

describe('loginCliInvokeLines — managed Node, never PATH-only claude', () => {
  it('Windows uses the managed entry plus ELECTRON_RUN_AS_NODE', () => {
    const lines = loginCliInvokeLines('claude-cli', true, {
      command: 'C:\\Metis\\Metis.exe',
      args: ['C:\\Users\\tony\\managed-cli\\claude\\cli.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(lines).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(lines.some((l) => l.includes('Metis.exe') && l.includes('cli.js'))).toBe(true)
    expect(lines.join('\n')).not.toMatch(/call claude/)
  })

  it('Windows Codex login appends login to the managed entry', () => {
    const lines = loginCliInvokeLines('codex-cli', true, {
      command: 'C:\\Metis\\Metis.exe',
      args: ['D:\\managed-cli\\codex\\bin\\codex.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(lines.join(' ')).toMatch(/codex\.js" "login"/)
  })

  it('falls back to PATH only when nothing is managed', () => {
    expect(loginCliInvokeLines('claude-cli', true, null)).toEqual(['call claude'])
    expect(loginCliInvokeLines('codex-cli', false, null)).toEqual(['codex login'])
  })

  it('Windows login invokes a resolved native claude.exe, never call claude', () => {
    const lines = loginCliInvokeLines('claude-cli', true, null, 'C:\\Users\\tony\\.local\\bin\\claude.exe')
    expect(lines).toEqual(['"C:\\Users\\tony\\.local\\bin\\claude.exe"'])
    expect(lines.join('\n')).not.toMatch(/call claude/)
  })

  it('prefers a licensed native exe over managed Electron-as-node', () => {
    const lines = loginCliInvokeLines(
      'claude-cli',
      true,
      {
        command: 'C:\\Metis\\Metis.exe',
        args: ['C:\\managed\\cli.js'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      'C:\\Users\\tony\\.local\\bin\\claude.exe'
    )
    expect(lines.join('\n')).toContain('.local\\bin\\claude.exe')
    expect(lines.join('\n')).not.toMatch(/ELECTRON_RUN_AS_NODE/)
  })

  it('never invokes a WindowsApps Desktop alias even if resolveBin leaked one', () => {
    const lines = loginCliInvokeLines(
      'claude-cli',
      true,
      null,
      'C:\\Users\\tony\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe'
    )
    expect(lines).toEqual(['call claude'])
  })

  it('Mac login quotes a resolved ~/.local/bin/claude', () => {
    const lines = loginCliInvokeLines('claude-cli', false, null, '/Users/tony/.local/bin/claude')
    expect(lines).toEqual(['"/Users/tony/.local/bin/claude"'])
  })

  // M2-0147 — `loginScriptPathSafe` used cmd.exe's rule (quote/CR/LF/%) unconditionally, even on the
  // bash branch, where `$`, backtick and `\` stay live inside double quotes.
  it('C3: Mac login never embeds a resolved path bash would expand inside double quotes', () => {
    expect(loginCliInvokeLines('claude-cli', false, null, '/Users/x/$(id)/claude')).toEqual(['claude'])
    expect(loginCliInvokeLines('claude-cli', false, null, '/Users/x/`id`/claude')).toEqual(['claude'])
  })

  // M2-0147 — the managed-launcher branch (an in-app one-click Node install) embedded
  // `managed.command`/`managed.args` with NO validation at all, unlike the resolved-bin branch above.
  it('C5: Windows login does not embed a managed launcher path cmd.exe would expand', () => {
    const lines = loginCliInvokeLines('claude-cli', true, {
      command: 'C:\\Users\\a%b\\Metis.exe',
      args: ['C:\\Users\\a\\managed-cli\\claude\\cli.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(lines).toEqual(['call claude'])
  })
})

// M2-0147 — cmdShimSpawn's bin check and the login script's path check had not drifted apart (both
// already reject only quote/CR/LF/%) — but nothing PINNED that, so a future edit to either copy could
// silently diverge. isQuotablePath(path, dialect) is now the one shared rule both call sites use.
describe('cmdShimSpawn and the Windows login script share one quoted-path rule (M2-0147)', () => {
  const UNQUOTABLE_CMD = ['"', '\r', '\n', '%']
  const QUOTABLE_CMD = ['&', '|', '(', ')', '^', '<', '>', '!', ' ']

  it('C4: the shim launcher and the Windows login script refuse exactly the same path characters', () => {
    for (const ch of UNQUOTABLE_CMD) {
      const bin = `C:\\npm\\cla${ch}ude.cmd`
      expect(() => cmdShimSpawn(bin, [])).toThrow()
      expect(loginCliInvokeLines('claude-cli', true, null, bin)).toEqual(['call claude'])
    }
    for (const ch of QUOTABLE_CMD) {
      const bin = `C:\\npm\\cla${ch}ude.cmd`
      expect(() => cmdShimSpawn(bin, [])).not.toThrow()
      expect(loginCliInvokeLines('claude-cli', true, null, bin)).toEqual([`call "${bin}"`])
    }
  })
})

/** A minimal fake ChildProcess: a real EventEmitter (readline/close listeners behave exactly as they
 *  would against a real spawn), settled asynchronously so callers awaiting the real Promise chain in
 *  openCliScript never resolve synchronously inside their own executor. */
function fakeChild(settle: (emitter: EventEmitter) => void): EventEmitter {
  const emitter = new EventEmitter()
  queueMicrotask(() => settle(emitter))
  return emitter
}

// RF-AUDIT-R3-B1 — openCliScript passed the generated scriptPath to spawn() exactly as generated. Node's
// own Windows argv-to-command-line quoting only wraps an argument that contains a space/tab or is empty;
// it has no notion of cmd.exe's own command-separator/expansion metacharacters. Because the target here
// IS cmd.exe (via `/c`), an unquoted `&`, `^`, `(`, `)` or `%` in a profile/temp scriptPath reached
// cmd.exe's own line parser live, letting cmd.exe treat text after it as a second, independent command.
// loginCli is the caller that reaches openCliScript (setupCli always uses shell.openPath directly).
describe('openCliScript (via loginCli) — the Windows script path cannot let cmd.exe re-parse it (RF-AUDIT-R3-B1)', () => {
  it('quotes a scriptPath containing cmd.exe metacharacters and sets windowsVerbatimArguments', async () => {
    setPlatform('win32')
    const savedDir = h.dir
    const evilDir = mkdtempSync(join(tmpdir(), 'asktoto-cli-script-evil & (paren) ^caret-'))
    h.dir = evilDir
    let captured: { command: string; args: string[]; options: Record<string, unknown> } | null = null
    spawnH.impl.mockImplementationOnce((command: string, args: string[], options: Record<string, unknown>) => {
      captured = { command, args, options }
      return fakeChild((emitter) => emitter.emit('close', 0))
    })

    try {
      const res = await loginCli('claude-cli')
      expect(res).toEqual({ ok: true })
      expect(captured).not.toBeNull()
      const scriptPath = join(evilDir, readdirSync(evilDir)[0]!)
      // The path must survive as ONE quoted token: if cmd.exe ever re-parsed it, '&', '^', '(' and ')'
      // outside a quote would end the `start` statement and begin a new one.
      expect(captured!.args).toEqual(['/d', '/c', 'start', '""', `"${scriptPath}"`])
      expect(captured!.options.windowsVerbatimArguments).toBe(true)
    } finally {
      h.dir = savedDir
      rmSync(evilDir, { recursive: true, force: true })
    }
  })

  it('never hands cmd.exe a scriptPath it cannot safely quote (%) — falls back to shell.openPath', async () => {
    setPlatform('win32')
    const savedDir = h.dir
    const evilDir = mkdtempSync(join(tmpdir(), 'asktoto-cli-script-100% off-'))
    h.dir = evilDir

    try {
      const res = await loginCli('claude-cli')
      expect(res).toEqual({ ok: true })
      // % is not neutralized by quoting (cmd.exe expands it even inside quotes) — the only safe move is
      // to never hand this path to cmd.exe at all and let shell.openPath (mocked above) open it instead.
      expect(spawnH.impl).not.toHaveBeenCalled()
    } finally {
      h.dir = savedDir
      rmSync(evilDir, { recursive: true, force: true })
    }
  })

  // A captured-args assertion (above) cannot prove cmd.exe itself would not split the path — the
  // previous command line looked plausible too, and cmd.exe still ran whatever followed an unquoted
  // `&`. This spawns a REAL cmd.exe with the exact args openCliScript builds and proves the segment
  // after the embedded `&` never runs as an independent command. No space appears anywhere in the
  // crafted path: Node's OWN default Windows quoting already quotes an argument containing a space
  // even without windowsVerbatimArguments, which would mask exactly the gap this test exists to catch.
  // Windows-only: it depends on cmd.exe's own parsing (declared in scripts/check-skipped-tests.mjs).
  it.skipIf(process.platform !== 'win32')(
    'RF-AUDIT-R3-B1: a real cmd.exe cannot split an unquoted `&` in the script path into a second command',
    async () => {
      setPlatform('win32')
      const savedDir = h.dir
      const evilDir = mkdtempSync(join(tmpdir(), 'asktoto-cli-script-evil&hack.cmd&rem-'))
      const sandbox = mkdtempSync(join(tmpdir(), 'asktoto-argv-sandbox-'))
      // If cmd.exe ever treats the `&` in evilDir's name as a separator, the text between the two `&`s
      // runs as a second, independent command — a bare relative filename cmd.exe looks up in its own
      // cwd (set to `sandbox` below), needing no space, which would trigger Node's own quoting.
      writeFileSync(join(sandbox, 'hack.cmd'), '@echo off\r\nmd hacked-marker\r\n', 'ascii')
      h.dir = evilDir

      spawnH.impl.mockImplementationOnce((command: string, args: string[], options: Record<string, unknown>) =>
        fakeChild((emitter) => {
          const r = spawnH.realSync!(command, args, { ...(options as object), cwd: sandbox })
          if (r.error) emitter.emit('error', r.error)
          else emitter.emit('close', r.status ?? 0)
        })
      )

      try {
        const res = await loginCli('claude-cli')
        expect(res).toEqual({ ok: true })
        expect(existsSync(join(sandbox, 'hacked-marker'))).toBe(false)
      } finally {
        h.dir = savedDir
        // The command line above is real: `start` hands the login script to a genuine detached cmd.exe
        // whose console ends in `pause` — it is still alive, holding `sandbox` as its inherited cwd,
        // long after this test resumes (nothing ever sends it a keypress). Reap it before deleting the
        // directories it is using, or Windows refuses the rmdir with EBUSY forever, not just transiently.
        // Matching on evilDir's own path — unique to this test run — can only hit the process this test
        // just spawned.
        const needle = evilDir.replace(/'/g, "''")
        spawnH.realSync!('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ])
        // Belt and suspenders: Stop-Process returns before Windows has necessarily released the file
        // handles, so retry the way Node's own recursive rm is designed to for exactly that gap.
        rmSync(evilDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  )
})
