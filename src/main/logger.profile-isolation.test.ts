import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const logFixture = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { root: mkdtempSync(join(tmpdir(), 'metis-logger-profile-')) }
})

// Do not clear or inspect the scratch audit file other workers are actively writing.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  tmpdir: () => logFixture.root
}))

vi.mock('electron')

import { auditLog, auditLogPath, mainLog } from './logger'

/**
 * MQA-177 — a test run must never write into the installed app's user profile.
 *
 * electron-log resolves its own file path. Outside an Electron main process (`process.type !== 'browser'`)
 * it falls back to NodeExternalApi, whose log directory is `<appData>/<package.json name>/logs` — byte for
 * byte the directory the installed app owns. So every vitest worker that imported a main module appended
 * its noise into the real user's `%APPDATA%\asktoto\logs\main.log`: the file a support engineer reads to
 * diagnose a field crash, interleaved with lines no field build ever emitted.
 */

/** The log directory the installed app owns, derived exactly as electron-log's Node fallback derives it. */
function installedAppLogDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'asktoto')
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(appData, 'asktoto', 'logs')
}

const scratchLogDir = join(tmpdir(), 'asktoto-nonapp-logs')

afterAll(() => rmSync(logFixture.root, { recursive: true, force: true }))

describe('MQA-177 — logs written under test land nowhere near the real user profile', () => {
  it('MQA-331 owns a unique fixture for real main and audit writes', () => {
    expect(auditLogPath()).toBe(join(logFixture.root, 'asktoto-nonapp-logs', 'audit.log'))
    expect(mainLog.transports.file.getFile().path).toBe(
      resolve(join(logFixture.root, 'asktoto-nonapp-logs', 'main.log'))
    )
  })

  it('resolves main.log to the scratch dir, never the installed app log directory', () => {
    const resolved = mainLog.transports.file.getFile().path

    expect(resolved).toBe(resolve(join(scratchLogDir, 'main.log')))
    expect(resolved.startsWith(installedAppLogDir())).toBe(false)
  })

  it('writes audit records to the scratch dir, never userData/logs/audit.log', () => {
    const scratchAudit = join(scratchLogDir, 'audit.log')
    rmSync(scratchAudit, { force: true })

    auditLog('key.set', { mqa: 'MQA-177' })

    expect(existsSync(scratchAudit)).toBe(true)
    expect(readFileSync(scratchAudit, 'utf8')).toContain('MQA-177')
  })
})
