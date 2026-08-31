import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

describe('AUDIT-10 — askStart never forwards Error.message to the overlay', () => {
  it('the outer catch sends a constant sentence', () => {
    const end = indexSrc.indexOf('ipcMain.handle(IPC.askCancel')
    expect(end).toBeGreaterThan(-1)
    const body = indexSrc.slice(end - 280, end)
    expect(body).toMatch(/\} catch \{/)
    expect(body).toMatch(/message: 'Could not start the answer\.'/)
    expect(body).not.toMatch(/e\.message/)
    expect(body).not.toMatch(/instanceof Error/)
  })
})

describe('AUDIT-10 — SSO-gated listening and ask side effects', () => {
  it('listeningState requires a signed-in session before Dust prewarm or speaker reset', () => {
    const body = sliceBetween('ipcMain.handle(IPC.listeningState', 'ipcMain.handle(IPC.windowResize')
    expect(body).toMatch(/assertMainWindow\(e\)/)
    expect(body).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(body.indexOf('if (!requireAuth()) return')).toBeLessThan(body.indexOf('listeningActive = !!on'))
  })

  it('askResetContext and askCancel require a signed-in session', () => {
    const reset = sliceBetween('ipcMain.handle(IPC.askResetContext', 'ipcMain.handle(IPC.armAudio')
    expect(reset).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(reset.indexOf('if (!requireAuth()) return')).toBeLessThan(reset.indexOf('resetDustConversation()'))

    const cancel = sliceBetween('ipcMain.handle(IPC.askCancel', 'ipcMain.handle(IPC.askResetContext')
    expect(cancel).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(cancel.indexOf('if (!requireAuth()) return')).toBeLessThan(cancel.indexOf('streams.get(id)'))
  })
})

describe('AUDIT-10 — outbound IPC caps sit in front of the network', () => {
  it('licenseActivate consumes the license-activate bucket before activateLicense', () => {
    const body = sliceBetween('ipcMain.handle(IPC.licenseActivate', 'ipcMain.handle(IPC.licenseStatus')
    expect(body).toMatch(/denyIfLimited\('license-activate'\)/)
    expect(body.indexOf("denyIfLimited('license-activate')")).toBeLessThan(body.indexOf('activateLicense'))
    expect(body).not.toMatch(/if \(!requireAuth\(\)\)/)
  })

  it('MCP test/save/push and calendarToday consume their buckets after requireAuth', () => {
    const test = sliceBetween('ipcMain.handle(IPC.mcpTestConnection', 'ipcMain.handle(IPC.mcpSaveConnection')
    expect(test).toMatch(/denyIfLimited\('mcp-outbound'\)/)
    expect(test.indexOf('requireAuth()')).toBeLessThan(test.indexOf("denyIfLimited('mcp-outbound')"))

    const save = sliceBetween('ipcMain.handle(IPC.mcpSaveConnection', 'ipcMain.handle(IPC.mcpDisconnect')
    expect(save).toMatch(/denyIfLimited\('mcp-outbound'\)/)

    const push = sliceBetween('ipcMain.handle(IPC.mcpPush', 'ipcMain.handle(IPC.mcpClickupConnect')
    expect(push).toMatch(/denyIfLimited\('mcp-outbound'\)/)
    expect(push).toMatch(/const conn = s\.mcpConnections\.find/)

    const cal = sliceBetween('ipcMain.handle(IPC.calendarToday', 'ipcMain.handle(IPC.recallRead')
    expect(cal).toMatch(/denyIfLimited\('graph-calendar'\)/)
    expect(cal.indexOf('requireAuth()')).toBeLessThan(cal.indexOf("denyIfLimited('graph-calendar')"))
  })

  it('the capture path does not call denyIfLimited', () => {
    const save = sliceBetween('ipcMain.handle(IPC.saveTranscript', 'ipcMain.handle(IPC.brainOpenDashboard')
    expect(save).not.toMatch(/denyIfLimited/)
    const feed = sliceBetween('ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(feed).not.toMatch(/denyIfLimited/)
    const arm = sliceBetween('ipcMain.handle(IPC.armAudio', 'ipcMain.handle(IPC.saveTranscript')
    expect(arm).not.toMatch(/denyIfLimited/)
  })
})

describe('AUDIT-10 — IPC sender denials are audited, sampled', () => {
  it('assertMainWindow records a reason before throwing', () => {
    const body = sliceBetween('function assertMainWindow', 'function assertBrainReader')
    expect(body).toMatch(/noteIpcDenied\('no_window'\)/)
    expect(body).toMatch(/noteIpcDenied\('sender'\)/)
    expect(body).toMatch(/noteIpcDenied\('frame'\)/)
    expect(indexSrc).toMatch(/auditLog\('security\.ipc_denied'/)
    expect(indexSrc).toMatch(/auditLog\('security\.rate_limited'/)
  })
})
