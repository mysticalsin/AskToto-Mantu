import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The temp dir the app writes its setup/login script into. Hoisted so the electron mock (which is
// itself hoisted above the imports) can read it lazily, once beforeAll has created the real dir.
const h = vi.hoisted(() => ({ dir: '' }))

// Hoisted handles onto the electron/child_process mocks below, so tests can assert on calls without
// re-importing the mocked modules. `openPath` is what RF-AUDIT-R3-B1's fix uses to open every
// setup/login script: the Windows script opens via shell.openPath with the exact path, and nothing is
// spawned (see the SECURITY INVARIANTS header in cli.ts). `spawn` is a plain recording stub, so a
// regression that spawns anything for this path is caught by `expect(mocks.spawn).not.toHaveBeenCalled()`
// on every OS.
const mocks = vi.hoisted(() => ({
  openPath: vi.fn(async () => ''),
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  shell: { openPath: mocks.openPath }
}))

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>()
  return { ...actual, spawn: mocks.spawn }
})

// The self-contained installer is irrelevant here but is imported by cli.ts at module load.
vi.mock('./cli-installer', () => ({
  managedCliEntry: vi.fn(() => null),
  managedCliCommand: vi.fn(() => null),
  installManagedCli: vi.fn()
}))

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
  mocks.openPath.mockClear()
  mocks.spawn.mockClear()
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
      args: ['C:\\Users\\example\\managed-cli\\claude\\cli.js'],
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
    const lines = loginCliInvokeLines('claude-cli', true, null, 'C:\\Users\\example\\.local\\bin\\claude.exe')
    expect(lines).toEqual(['"C:\\Users\\example\\.local\\bin\\claude.exe"'])
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
      'C:\\Users\\example\\.local\\bin\\claude.exe'
    )
    expect(lines.join('\n')).toContain('.local\\bin\\claude.exe')
    expect(lines.join('\n')).not.toMatch(/ELECTRON_RUN_AS_NODE/)
  })

  it('never invokes a WindowsApps Desktop alias even if resolveBin leaked one', () => {
    const lines = loginCliInvokeLines(
      'claude-cli',
      true,
      null,
      'C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe'
    )
    expect(lines).toEqual(['call claude'])
  })

  it('Mac login quotes a resolved ~/.local/bin/claude', () => {
    const lines = loginCliInvokeLines('claude-cli', false, null, '/Users/example-owner/.local/bin/claude')
    expect(lines).toEqual(['"/Users/example-owner/.local/bin/claude"'])
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

// RF-AUDIT-R3-B1 — the invariant these tests pin (full rationale in the SECURITY INVARIANTS header in
// cli.ts): for a scriptPath containing cmd.exe metacharacters or a literal `%NAME%`, loginCli opens it
// via shell.openPath with the exact, unmodified path, and spawns nothing. `spawn` is a recording stub
// and `openPath` never touches a real shell, so these tests do not exercise cmd.exe's or ShellExecute's
// own parsing — they only prove which call path loginCli takes.
describe('loginCli opens the Windows script via shell.openPath, never a spawned cmd.exe (RF-AUDIT-R3-B1)', () => {
  it.each([
    ['ampersand + space', 'asktoto-cli-script-evil & co '],
    ['parens + caret', 'asktoto-cli-script-(evil) ^caret-'],
    ['percent', 'asktoto-cli-script-100% off-']
  ])('%s in the temp dir: shell.openPath gets exactly the scriptPath, spawn is never called', async (_label, prefix) => {
    setPlatform('win32')
    const savedDir = h.dir
    const evilDir = mkdtempSync(join(tmpdir(), prefix))
    h.dir = evilDir
    try {
      const { name } = await capture(() => loginCli('claude-cli'))
      expect(mocks.openPath).toHaveBeenCalledTimes(1)
      expect(mocks.openPath).toHaveBeenCalledWith(join(evilDir, name))
      expect(mocks.spawn).not.toHaveBeenCalled()
    } finally {
      h.dir = savedDir
      rmSync(evilDir, { recursive: true, force: true })
    }
  })
})
