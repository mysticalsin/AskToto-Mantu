import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.mock('electron')

import log from 'electron-log'

/**
 * MQA-177 — a test run must never write into the installed app's log file.
 *
 * electron-log's default logger resolves its own path, and outside an Electron main process
 * (`process.type !== 'browser'`) it falls back to NodeExternalApi, whose log directory is
 * `<appData>/<package.json name>/logs` — byte for byte the directory the installed app owns.
 * `src/main/logger.ts` corrects that, but only as a module-load side effect: the guard exists only in a
 * test whose import graph happens to reach logger.ts.
 *
 * `updater.ts` and `win-security.ts` imported `electron-log` directly instead of going through the module
 * that owns logging policy, so their import graphs never loaded the guard. The result was live on this
 * machine: `%APPDATA%\asktoto\logs\main.log` held 4331 `[updater]` lines emitted by `updater.test.ts`
 * (including its `sha512 checksum mismatch` fixture and its fake `downloaded 1.5.5`), interleaved with
 * genuine field lines in the exact file a support engineer reads to diagnose a crash.
 *
 * This file deliberately does NOT import `./logger`. It imports a module that logs, and asserts the guard
 * is there anyway — which is only true when logger.ts is the single door to electron-log.
 */

import './updater'

/** The log directory the installed app owns, derived exactly as electron-log's Node fallback derives it. */
function installedAppLogDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'asktoto')
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(appData, 'asktoto', 'logs')
}

/** Every non-test TypeScript source file under src/main, recursively. */
function mainSourceFiles(dir = resolve(__dirname)): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return mainSourceFiles(full)
    return entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name) ? [full] : []
  })
}

describe('MQA-177 — logger.ts is the single owner of the electron-log singleton', () => {
  it('MQA-177: a module that logs resolves main.log outside the installed app profile, without importing ./logger', () => {
    const resolved = log.transports.file.getFile().path

    expect(resolved).toBe(resolve(join(tmpdir(), 'asktoto-nonapp-logs', 'main.log')))
    expect(resolved.startsWith(installedAppLogDir())).toBe(false)
  })

  it('MQA-177: no main-process module except logger.ts imports electron-log directly', () => {
    const offenders = mainSourceFiles()
      .filter((file) => /from 'electron-log'/.test(readFileSync(file, 'utf8')))
      .filter((file) => !file.endsWith(join('src', 'main', 'logger.ts')))
      .map((file) => file.slice(file.lastIndexOf(join('src', 'main'))))

    expect(offenders).toEqual([])
  })
})
