/**
 * diagnostics-export.contract.test.ts — the support bundle diagnoses the app, never moves content.
 *
 * The handler is a closure inside index.ts (which boots Electron at import time), so the wiring is
 * pinned against the real source — the same structural-proof pattern every sibling *.contract.test.ts
 * uses for main-process seams.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const preloadSrc = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')

function handler(): string {
  const start = indexSrc.indexOf('ipcMain.handle(IPC.diagnosticsExport')
  expect(start, 'diagnosticsExport handler must exist').toBeGreaterThan(-1)
  return indexSrc.slice(start, indexSrc.indexOf('ipcMain.handle(', start + 1))
}

describe('diagnostics export — logs out, content never', () => {
  it('is gated like every privileged channel: sender assertion + auth', () => {
    const body = handler()
    expect(body).toMatch(/assertMainWindow\(e\)/)
    expect(body).toMatch(/if \(!requireAuth\(\)\)/)
  })

  it('collects exactly the diagnostic surfaces: logs, crash dumps, boot sentinel, manifest', () => {
    const body = handler()
    expect(body).toMatch(/logsDir/)
    expect(body).toMatch(/\^crash-\.\*\\\.log\$/)
    expect(body).toMatch(/boot-incomplete\.json/)
    expect(body).toMatch(/MANIFEST\.txt/)
  })

  it('NEVER reaches for meetings, the brain store, the wiki mirror, or settings.json', () => {
    const body = handler()
    expect(body).not.toMatch(/resolveMeetingsFolder/)
    expect(body).not.toMatch(/brainDir\(/)
    expect(body).not.toMatch(/'settings\.json'/)
    expect(body).not.toMatch(/readSavedFile/)
    // The exclusion is stated to the reader of the bundle, not just to the code reviewer.
    expect(body).toMatch(/Deliberately NOT included/)
  })

  it('audits the export (metadata only) and the event is a declared AuditEvent', () => {
    expect(handler()).toMatch(/auditLog\('diagnostics\.export', \{ files: copied\.length \}\)/)
    const loggerSrc = readFileSync(join(__dirname, 'logger.ts'), 'utf8')
    expect(loggerSrc).toMatch(/\| 'diagnostics\.export'/)
  })

  it('is exposed to the renderer through the preload bridge', () => {
    expect(preloadSrc).toMatch(/diagnosticsExport: \(\): Promise<DiagnosticsExportResult> => ipcRenderer\.invoke\(IPC\.diagnosticsExport\)/)
  })
})

describe('DevTools posture — disabled where they are not a development tool', () => {
  // This assertion used to read ONLY index.ts while claiming to cover "every BrowserWindow". It
  // therefore counted 3 == 3 and passed, while src/main/intelligence.ts constructed a fourth window
  // with no devTools key at all — Electron's default is true, so DevTools were openable in a shipped
  // build on the window whose preload can read the decrypted brain. Walk the whole directory instead,
  // so a new window anywhere in src/main cannot be born ungated.
  const mainFiles = readdirSync(__dirname)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.contract.test.ts'))
    .map((f) => ({ file: f, src: readFileSync(join(__dirname, f), 'utf8') }))
    .filter((f) => f.src.includes('new BrowserWindow('))

  it('the shared gate is fail-closed and routed through the dev-env hatch', () => {
    const devEnvSrc = readFileSync(join(__dirname, 'dev-env.ts'), 'utf8')
    expect(devEnvSrc).toMatch(/export function devToolsEnabled\(\): boolean/)
    expect(devEnvSrc).toContain("!isPackagedBuild() || devEnv('ASKTOTO_DEVTOOLS') === '1'")
  })

  it('every BrowserWindow in src/main gates devTools — not just the ones in index.ts', () => {
    // Guard against the file list silently emptying and the test passing vacuously.
    expect(mainFiles.length, 'no BrowserWindow construction found in src/main').toBeGreaterThan(0)
    for (const { file, src } of mainFiles) {
      const windows = src.split('new BrowserWindow(').length - 1
      const gated =
        src.split('devTools: DEVTOOLS_ENABLED').length - 1 + (src.split('devTools: devToolsEnabled()').length - 1)
      expect(gated, `${file}: every window construction must carry the devTools gate`).toBe(windows)
    }
  })
})
