/**
 * diagnostics-export.contract.test.ts — the support bundle diagnoses the app, never moves content.
 *
 * The handler is a closure inside index.ts (which boots Electron at import time), so the wiring is
 * pinned against the real source — the same structural-proof pattern every sibling *.contract.test.ts
 * uses for main-process seams.
 */
import { readFileSync } from 'node:fs'
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
  it('every BrowserWindow gates devTools on the shared packaged-build constant', () => {
    expect(indexSrc).toMatch(/const DEVTOOLS_ENABLED = !app\.isPackaged \|\| process\.env\.ASKTOTO_DEVTOOLS === '1'/)
    const gated = indexSrc.split('devTools: DEVTOOLS_ENABLED').length - 1
    const windows = indexSrc.split('new BrowserWindow(').length - 1
    expect(gated, 'every window construction must carry the gate').toBe(windows)
  })
})
