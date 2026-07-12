import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Source-contract tests for the C_Main fix batch (main/index.ts + main/store.ts wiring gaps). Same
 * structural-proof pattern as will-quit-guard.test.ts / crash-capture.test.ts: index.ts has no direct
 * handler-test harness (globalShortcut, BrowserWindow, and the ffmpeg child process all require a real
 * Electron runtime), so these pin the wiring via the raw source text instead of executing it. Each test
 * traces to exactly one fix-spec finding (metis-qa/fixspecs/C_Main.md).
 */

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('finding 1: "settings" hotkey is registered, not just bindable', () => {
  it('shortcutActions includes a settings entry wired to sendHotkey', () => {
    const start = source.indexOf('const shortcutActions: Record<string, () => void> = {')
    const end = source.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, end)
    expect(body).toMatch(/settings:\s*\(\)\s*=>\s*sendHotkey\('settings'\)/)
  })
})

describe('findings 2 & 4: visionAvailable consults per-agent Dust vision, not the static flag', () => {
  it("uses dustSelectedAgentVision for 'dust' inside the visionAvailable .some() predicate", () => {
    const start = source.indexOf('visionAvailable:')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    expect(body).toMatch(/p === 'dust' \? dustSelectedAgentVision\(s\.providerModels\['dust'\]\) : PROVIDERS\[p\]\.vision/)
    // Must still be gated by the org allowlist and the existing key/CLI-connected check, same as before.
    expect(body).toMatch(/!allowed \|\| allowed\.includes\(p\)/)
    expect(body).toMatch(/hasApiKey\(p\)/)
  })
})

describe('finding 5: cliPrimary is filtered by the org allowlist', () => {
  it('the claude-cli/codex-cli .find() checks `allowed` alongside cliConnected', () => {
    const start = source.indexOf('const cliPrimary =')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 300)
    expect(body).toMatch(/s\.cliConnected\[p\] && \(!allowed \|\| allowed\.includes\(p\)\)/)
  })
})

describe('finding 6: ffmpeg import decoder is killed on ASR/transcription failure', () => {
  it("onError cancels the decoder (from the ffmpegDecoders map) before deleting the map entry", () => {
    const start = source.indexOf("onError: async (error) => {")
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('}', source.indexOf('failDecoder', start))
    const body = source.slice(start, end)
    const cancelIdx = body.indexOf('ffmpegDecoders.get(job.jobId)?.cancel()')
    const deleteIdx = body.indexOf('ffmpegDecoders.delete(job.jobId)')
    expect(cancelIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(-1)
    // Cancel (SIGTERM to the still-alive ffmpeg child) must happen before the bookkeeping delete.
    expect(cancelIdx).toBeLessThan(deleteIdx)
  })
})

describe('finding 8: duplicate global-hotkey accelerators are surfaced, not silently dropped', () => {
  it('registerShortcuts tracks claimed accelerators and pushes a duplicate into shortcutFailures', () => {
    const start = source.indexOf('function registerShortcuts(): void {')
    const end = source.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, end)
    expect(body).toMatch(/const claimedBy = new Map/)
    expect(body).toMatch(/const dupeOf = claimedBy\.get\(accel\)/)
    // A duplicate must be pushed to shortcutFailures and must NOT reach globalShortcut.register (the
    // `continue` keeps the dupe branch from falling through into the register() call below it).
    const dupeStart = body.indexOf('if (dupeOf) {')
    const dupeEnd = body.indexOf('continue', dupeStart)
    expect(dupeStart).toBeGreaterThan(-1)
    expect(dupeEnd).toBeGreaterThan(-1)
    const dupeBlock = body.slice(dupeStart, dupeEnd)
    expect(dupeBlock).toMatch(/shortcutFailures\.push\(\{ action, accel \}\)/)
  })
})

describe('finding 9: renderer crash recovery on the main overlay window', () => {
  it("render-process-gone is registered unconditionally (not gated behind ASKTOTO_DEBUG_RENDERER)", () => {
    // The overlay's own render-process-gone listener (not the hidden decoder window's, which is a
    // separate, pre-existing listener earlier in the file) must sit OUTSIDE the ASKTOTO_DEBUG_RENDERER
    // block so it's active in a packaged/production build, not just a debug one.
    const debugBlockStart = source.indexOf('if (process.env.ASKTOTO_DEBUG_RENDERER) {')
    const debugBlockEnd = source.indexOf('\n  }', debugBlockStart)
    const listenerIdx = source.indexOf("win.webContents.on('render-process-gone'", debugBlockEnd)
    expect(debugBlockStart).toBeGreaterThan(-1)
    expect(listenerIdx).toBeGreaterThan(-1)
    expect(listenerIdx).toBeGreaterThan(debugBlockEnd) // registered after (outside) the debug-only block
  })

  it('logs to mainLog + auditLog and reloads the window content instead of leaving it blank', () => {
    const listenerStart = source.indexOf("win.webContents.on('render-process-gone', (_e, details) => {")
    expect(listenerStart).toBeGreaterThan(-1)
    const listenerEnd = source.indexOf('\n  })', listenerStart)
    const body = source.slice(listenerStart, listenerEnd)
    expect(body).toMatch(/mainLog\.error\(/)
    expect(body).toMatch(/auditLog\('app\.crash', \{ kind: 'render-process-gone'/)
    expect(body).toMatch(/win\.isDestroyed\(\)/)
    expect(body).toMatch(/win\.loadURL\(process\.env\['ELECTRON_RENDERER_URL'\]\)/)
    expect(body).toMatch(/win\.loadFile\(join\(__dirname, '\.\.\/renderer\/index\.html'\)\)/)
  })
})

describe('finding 7: brain:rebuildAll stays guarded (assessed, not modified)', () => {
  it('the handler requires both assertMainWindow and requireAuth before purging', () => {
    const start = source.indexOf('ipcMain.handle(IPC.brainRebuildAll,')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n  })', start)
    const body = source.slice(start, end)
    expect(body).toMatch(/assertMainWindow\(e\)/)
    expect(body).toMatch(/requireAuth\(\)/)
    // MI-2.5 superseded the direct purgeBrain(getSettings()) call with ingest.ts's startRebuild, which
    // still purges (preserveCorrections: true) but adds a corrupt-journal guard and a checked/resumable
    // corrections replay — same guarantee (guarded, not silently modified), stronger implementation.
    expect(body).toMatch(/startRebuild\(getSettings\(\)\)/)
  })
})
