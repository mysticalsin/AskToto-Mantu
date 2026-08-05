import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  installManagedCli: vi.fn()
}))

import { setupCli, loginCli } from './cli'

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
