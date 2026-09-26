import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract pins for the 2026-09-05 bank-grade hardening pass (see .rocket-fuel/METIS-BANK-GRADE-RECEIPT.md).
 * Same technique as c-main-fixes.contract.test.ts: index.ts cannot be imported in vitest (it boots Electron),
 * so each fix is pinned by the shape of its source. A future edit that quietly re-introduces the hole fails here.
 */
const src = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

function sliceBetween(start: string, end: string): string {
  const a = src.indexOf(start)
  if (a === -1) throw new Error(`marker not found: ${start}`)
  const b = src.indexOf(end, a)
  if (b === -1) throw new Error(`end marker not found after start: ${end}`)
  return src.slice(a, b)
}

describe('CLI IPC handlers parse the provider id instead of casting it', () => {
  const region = sliceBetween("ipcMain.handle(IPC.cliSetup,", '// --- MCP connections')

  it('cliSetup / cliInstall / cliLogin all route the renderer value through ProviderIdSchema', () => {
    expect(region).toContain('setupCli(cliProviderArg(provider))')
    expect(region).toContain('const p = cliProviderArg(provider)')
    expect(region).toContain('loginCli(cliProviderArg(provider))')
    expect(region).not.toMatch(/provider as ProviderId/)
  })

  it('cliProviderArg is a real parse with the same default the detect/test handlers use', () => {
    const def = sliceBetween('const cliProviderArg = (provider: unknown): ProviderId =>', "ipcMain.handle(IPC.cliSetup,")
    expect(def).toContain('ProviderIdSchema.safeParse(provider)')
    expect(def).toContain("parsed.success ? parsed.data : 'claude-cli'")
  })
})

describe('overlay window reports a wedged renderer', () => {
  it("registers 'unresponsive' and 'responsive' on the overlay, next to the render-process-gone recovery", () => {
    const region = sliceBetween("win.on('unresponsive', () => {", "win.webContents.on('render-process-gone', (_e, details) => {")
    expect(region).toContain("auditLog('app.unresponsive', { kind: 'overlay' })")
    expect(region).toContain("win.on('responsive', () => {")
    // The handler must not reload or kill the renderer on this signal (a stall mid-meeting is recoverable).
    const handler = sliceBetween("win.on('unresponsive', () => {", "win.on('responsive', () => {")
    expect(handler).not.toMatch(/loadURL|loadFile|reload|destroy|app\.exit|app\.quit|relaunch/)
  })
})

describe('session-long de-duplication sets are bounded', () => {
  it('notifiedImportJobs and notifiedKeys are BoundedSets, not bare Sets', () => {
    expect(src).toMatch(/const notifiedImportJobs = new BoundedSet<string>\(\d+\)/)
    expect(src).toMatch(/const notifiedKeys = new BoundedSet<string>\([\d_]+\)/)
    expect(src).not.toMatch(/const notifiedImportJobs = new Set</)
    expect(src).not.toMatch(/const notifiedKeys = new Set</)
  })
})

describe('managed egress allowlist is armed at boot, after the proxy, and never blocks boot', () => {
  it('installEgressGuard(getEgressAllowlist()) runs inside app.whenReady after installProxyAwareFetch, in a try/catch', () => {
    const region = sliceBetween('await installProxyAwareFetch()', 'prewarmCli()')
    expect(region).toMatch(/try \{\s*installEgressGuard\(getEgressAllowlist\(\)\)\s*\} catch/)
  })
})
