/**
 * Live smoke: installManagedCli('claude') against the real npm registry.
 * Proves the modern native layout (no cli.js) installs end-to-end on this host.
 *
 * Run: RUN_LIVE_CLI_INSTALL=1 ./node_modules/.bin/vitest run src/main/cli-installer.live.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

vi.mock('electron')

import { app } from 'electron'
import {
  installManagedCli,
  managedCliCommand,
  managedCliEntry,
  resolveClaudeNativePlatform,
  MIN_NATIVE_CLI_BYTES,
  type CliInstallProgress
} from './cli-installer'

const live = process.env.RUN_LIVE_CLI_INSTALL === '1'

describe.runIf(live)('installManagedCli — LIVE npm registry', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-cli-live-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it(
    'installs current @anthropic-ai/claude-code with the host native binary',
    async () => {
      const host = resolveClaudeNativePlatform(process.platform, process.arch, false)
      expect(host).not.toBeNull()

      const progress: CliInstallProgress[] = []
      const result = await installManagedCli('claude', (p) => {
        progress.push(p)
        if (p.phase === 'downloading' && p.totalBytes && p.receivedBytes != null) {
          const pct = Math.floor((100 * p.receivedBytes) / p.totalBytes)
          if (pct % 20 === 0) {
            // eslint-disable-next-line no-console
            console.log(`[live] downloading ${pct}% (${p.receivedBytes}/${p.totalBytes})`)
          }
        } else {
          // eslint-disable-next-line no-console
          console.log(`[live] phase=${p.phase}${p.error ? ` error=${p.error}` : ''}`)
        }
      })

      expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(existsSync(result.entry)).toBe(true)
      expect(statSync(result.entry).size).toBeGreaterThan(MIN_NATIVE_CLI_BYTES)
      // Must NOT be the legacy JS entry — that's the regression Tony hit on the EXE.
      expect(result.entry.endsWith('cli.js')).toBe(false)
      expect(result.entry.includes(join('bin', host!.binaryName)) || result.entry.endsWith(host!.binaryName)).toBe(
        true
      )

      const entry = managedCliEntry('claude')
      expect(entry?.version).toBe(result.version)
      expect(entry?.entry).toBe(result.entry)

      const cmd = managedCliCommand('claude')
      expect(cmd).not.toBeNull()
      expect(cmd!.command).toBe(result.entry)
      expect(cmd!.args).toEqual([])
      expect(cmd!.env).toEqual({})

      // Binary should at least start and print something (version / help) without crashing.
      const probe = spawnSync(result.entry, ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env }
      })
      // eslint-disable-next-line no-console
      console.log(`[live] --version status=${probe.status} out=${(probe.stdout || '').trim()} err=${(probe.stderr || '').trim().slice(0, 200)}`)
      expect(probe.error).toBeUndefined()
      // Claude may print version on stdout or stderr; either way it must exit 0 or print identifiable output.
      const combined = `${probe.stdout || ''}${probe.stderr || ''}`
      expect(probe.status === 0 || /claude|anthropic|\d+\.\d+/i.test(combined)).toBe(true)

      expect(progress.some((p) => p.phase === 'done')).toBe(true)
      expect(progress.some((p) => p.phase === 'error')).toBe(false)
    },
    10 * 60 * 1000
  )
})

describe.skipIf(live)('installManagedCli — LIVE npm registry (skipped)', () => {
  it('set RUN_LIVE_CLI_INSTALL=1 to enable', () => {
    expect(true).toBe(true)
  })
})
