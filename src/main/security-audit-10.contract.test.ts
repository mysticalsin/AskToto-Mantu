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
  it('the outer catch sends a constant sentence except for skill-lock integrity', () => {
    const end = indexSrc.indexOf('ipcMain.handle(IPC.askCancel')
    expect(end).toBeGreaterThan(-1)
    const body = indexSrc.slice(end - 420, end)
    expect(body).toMatch(/isModeSkillIntegrityError\(err\)/)
    expect(body).toMatch(/message: 'Could not start the answer\.'/)
    expect(body).not.toMatch(/e\.message/)
    expect(body).not.toMatch(/err\.message[\s\S]*Could not start the answer/)
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

  it('the live listen path uses takeHotPath so overflow is dropped, never queued', () => {
    const save = sliceBetween('ipcMain.handle(IPC.saveTranscript', 'ipcMain.handle(IPC.brainOpenDashboard')
    expect(save).toMatch(/takeHotPath\('save-transcript'\)/)
    expect(save.indexOf("takeHotPath('save-transcript')")).toBeLessThan(save.indexOf('saveMeeting'))

    const feed = sliceBetween('ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(feed).toMatch(/takeHotPath\('asr-feed'\)/)
    expect(feed.indexOf("takeHotPath('asr-feed')")).toBeLessThan(feed.indexOf('parakeetTranscribe'))

    const apple = sliceBetween('ipcMain.handle(IPC.appleSpeechFeed', 'ipcMain.handle(IPC.localModelsList')
    expect(apple).toMatch(/takeHotPath\('asr-feed'\)/)
    expect(apple).not.toMatch(/denyIfLimited/)

    const arm = sliceBetween('ipcMain.handle(IPC.armAudio', 'ipcMain.handle(IPC.saveTranscript')
    expect(arm).toMatch(/takeHotPath\('arm-audio'\)/)

    const capture = sliceBetween('ipcMain.handle(IPC.captureScreen', 'ipcMain.handle(IPC.prewarmCapture')
    expect(capture).toMatch(/takeHotPath\('capture-screen'\)/)
    expect(capture).not.toMatch(/denyIfLimited/)
  })
})

describe('AUDIT-10 — remaining disk/network IPC is SSO-gated', () => {
  it('localPrewarm, prewarmCapture, rendererCrash, and update channels require a session', () => {
    const prewarm = sliceBetween('ipcMain.handle(IPC.localPrewarm', 'ipcMain.handle(IPC.captureScreen')
    expect(prewarm).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(prewarm.indexOf('if (!requireAuth()) return')).toBeLessThan(prewarm.indexOf('LocalPrewarmPayloadSchema'))

    const captureWarm = sliceBetween('ipcMain.handle(IPC.prewarmCapture', 'ipcMain.handle(IPC.screenContext')
    expect(captureWarm).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(captureWarm.indexOf('if (!requireAuth()) return')).toBeLessThan(captureWarm.indexOf('prewarmCapture()'))

    const crash = sliceBetween('ipcMain.handle(IPC.rendererCrash', 'ipcMain.handle(IPC.windowMoveBy')
    expect(crash).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(crash.indexOf('if (!requireAuth()) return')).toBeLessThan(crash.indexOf('persistCrash'))

    const check = sliceBetween('ipcMain.handle(IPC.updateCheck', 'ipcMain.handle(IPC.updateDownload')
    expect(check).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(check.indexOf('if (!requireAuth()) return')).toBeLessThan(check.indexOf('checkForUpdateNow'))

    const download = sliceBetween('ipcMain.handle(IPC.updateDownload', 'ipcMain.handle(IPC.updateInstall')
    expect(download).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(download.indexOf('if (!requireAuth()) return')).toBeLessThan(download.indexOf('startUpdateDownload'))

    const install = sliceBetween('ipcMain.handle(IPC.updateInstall', 'ipcMain.handle(IPC.openMailDraft')
    expect(install).toMatch(/if \(!requireAuth\(\)\) return/)
    expect(install.indexOf('if (!requireAuth()) return')).toBeLessThan(install.indexOf('autoUpdater'))
  })

  it('licenseActivate stays ungated (license vs SSO deadlock) and still consumes its bucket', () => {
    const body = sliceBetween('ipcMain.handle(IPC.licenseActivate', 'ipcMain.handle(IPC.licenseStatus')
    expect(body).not.toMatch(/if \(!requireAuth\(\)\)/)
    expect(body).toMatch(/denyIfLimited\('license-activate'\)/)
  })
})

describe('AUDIT-10 — meeting-file IPC uses the shared basename allow-list', () => {
  it('recallOpen, recallExportPlain, recallDelete, and debriefSave call safeMeetingBasename', () => {
    const open = sliceBetween('ipcMain.handle(IPC.recallOpen', 'ipcMain.handle(IPC.openBrainForClaude')
    expect(open).toMatch(/safeMeetingBasename\(/)

    const exp = sliceBetween('ipcMain.handle(IPC.recallExportPlain', 'ipcMain.handle(IPC.diagnosticsExport')
    expect(exp).toMatch(/safeMeetingBasename\(/)

    const del = sliceBetween('ipcMain.handle(IPC.recallDelete', 'ipcMain.handle(IPC.recallRename')
    expect(del).toMatch(/safeMeetingBasename\(/)

    const debrief = sliceBetween('ipcMain.handle(IPC.debriefSave', 'ipcMain.handle(IPC.recallDeleteAll')
    expect(debrief).toMatch(/safeMeetingBasename\(/)
  })
})

describe('AUDIT-10 — no production SQL client in src/main', () => {
  it('does not import sqlite, postgres, or issue CREATE TABLE', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const root = __dirname
    const stack = [root]
    const hits: string[] = []
    while (stack.length) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!name.endsWith('.ts')) continue
        if (name.includes('.test.') || name.includes('.contract.')) continue
        const src = readFileSync(full, 'utf8')
        if (/\b(?:better-sqlite3|sqlite3|pg\.Pool|postgres|CREATE TABLE)\b/.test(src)) hits.push(full)
      }
    }
    expect(hits).toEqual([])
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

describe('AUDIT-10 — Shiki HTML is sanitized before dangerouslySetInnerHTML', () => {
  it('CodeBlock runs highlighter output through sanitizeShikiHtml', () => {
    const src = readFileSync(join(__dirname, '../renderer/src/components/CodeBlock.tsx'), 'utf8')
    expect(src).toMatch(/import \{ sanitizeShikiHtml \} from '@shared\/sanitize-html'/)
    expect(src).toMatch(/sanitizeShikiHtml\(h\.codeToHtml/)
    expect(src).toMatch(/dangerouslySetInnerHTML/)
  })
})

describe('AUDIT-10 extra — XSS / import / webhook', () => {
  it('the only renderer dangerouslySetInnerHTML is CodeBlock after sanitizeShikiHtml', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const root = join(__dirname, '../renderer/src')
    const hits: string[] = []
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          stack.push(full)
          continue
        }
        if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue
        const src = readFileSync(full, 'utf8')
        if (src.includes('dangerouslySetInnerHTML') && !full.endsWith('CodeBlock.tsx')) hits.push(full)
      }
    }
    expect(hits).toEqual([])
  })

  it('every HTML shell ships a CSP, and no BrowserWindow enables webviewTag', () => {
    for (const rel of ['../renderer/index.html', '../renderer/decoder.html', '../../intelligence/index.html']) {
      const html = readFileSync(join(__dirname, rel), 'utf8')
      expect(html).toMatch(/http-equiv="Content-Security-Policy"/)
      expect(html).toMatch(/script-src/)
    }
    expect(indexSrc).not.toMatch(/webviewTag:\s*true/)
    expect(indexSrc).not.toMatch(/<webview/)
  })

  it('markdown links and Graph join URLs go through safeHref', () => {
    const md = readFileSync(join(__dirname, '../renderer/src/components/Markdown.tsx'), 'utf8')
    expect(md).toMatch(/safeHref\(href\)/)
    const cal = readFileSync(join(__dirname, 'calendar.ts'), 'utf8')
    expect(cal).toMatch(/safeHref\(ev\?\.onlineMeeting\?\.joinUrl\)/)
    const agenda = readFileSync(join(__dirname, '../renderer/src/components/AgendaView.tsx'), 'utf8')
    expect(agenda).toMatch(/safeHref\(ev\.joinUrl\)/)
  })

  it('import never feeds ffmpeg until magic bytes say media, and never opens the source', () => {
    const pick = readFileSync(join(__dirname, 'import-audio.ts'), 'utf8')
    expect(pick).toMatch(/sniffMediaFile\(pick\.path\)/)
    const ff = readFileSync(join(__dirname, 'ffmpeg-decoder.ts'), 'utf8')
    const startFn = ff.indexOf('export function startFfmpegDecode')
    const endFn = ff.indexOf('\nexport ', startFn + 1)
    const body = endFn === -1 ? ff.slice(startFn) : ff.slice(startFn, endFn)
    expect(body).toContain('sniffMediaFile(sourcePath)')
    expect(body).toContain('IMPORT_NOT_MEDIA')
    expect(body.indexOf('sniffMediaFile(sourcePath)')).toBeLessThan(body.indexOf('child = spawn('))
    const start = sliceBetween('ipcMain.handle(IPC.importAudioStart', 'ipcMain.handle(IPC.importJobsList')
    expect(start).not.toMatch(/shell\.openPath/)
    expect(start).not.toMatch(/execFile|execSync/)
  })
})
