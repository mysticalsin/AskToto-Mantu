import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const preload = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
const ipc = readFileSync(join(__dirname, '../shared/ipc.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `missing start marker: ${start}`).toBeGreaterThan(-1)
  const to = source.indexOf(end, from)
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(-1)
  return source.slice(from, to)
}

describe('Cap2 command authority boundary', () => {
  it('exposes only sanitized command state plus id-and-nonce confirmation controls', () => {
    expect(preload).not.toContain('metisCommandIngest')
    expect(ipc).not.toContain('metisCommandIngest')
    expect(preload).not.toContain('metisCommandStop')
    expect(preload).toContain('onMetisCommandState')
    expect(preload).toContain('confirmMetisCommand')
    expect(preload).toContain('cancelMetisCommand')
    expect(ipc).toContain('metisCommandState')
    expect(ipc).toContain('metisCommandConfirm')
    expect(ipc).toContain('metisCommandCancel')
    expect(preload).not.toContain('executeDesktopAction')
  })

  it('guards command confirmation IPC with the main-window top-frame boundary', () => {
    const confirm = between(main, 'ipcMain.handle(IPC.metisCommandConfirm', 'ipcMain.handle(IPC.metisCommandCancel')
    expect(confirm).toContain('assertMainWindow(e)')
    expect(confirm).toContain('commandControl.confirm')
    expect(confirm).not.toContain('request')
  })

  it('revokes command authority when the owning window or renderer is replaced', () => {
    expect(main).toContain('const self = win')
    const closed = between(main, "win.on('closed', () => {", "win.webContents.setWindowOpenHandler(")
    expect(closed).toMatch(/if \(win !== self\) return\s*commandControl\.revokeForLifecycleEvent\('window_closed'\)/)
    const rendererGone = between(main, "win.webContents.on('render-process-gone', (_e, details) => {", 'const rendererUrl = overlayRendererUrl()')
    expect(rendererGone).toMatch(/if \(win !== self\) return\s*commandControl\.revokeForLifecycleEvent\('renderer_replaced'\)/)
    expect(rendererGone).toMatch(/if \(win !== self \|\| self\.isDestroyed\(\)\) return\s*self\.loadURL\(overlayRendererUrl\(\)\)/)
  })

  it('revokes command authority during replay handoff without letting retired-window close revoke the successor', () => {
    const handoff = between(
      main,
      'function replaceTransparentOverlayWithExclusiveOnboarding(): void {',
      '/** Exclusive hero hold'
    )
    const replacementReady = handoff.indexOf('coversExclusiveOnboardingDisplay(replacement, replacementDisplay)')
    const revokeForHandoff = handoff.indexOf("commandControl.revokeForLifecycleEvent('window_replaced')")
    const retireWindow = handoff.indexOf('dying.destroy()')
    expect(replacementReady).toBeGreaterThan(-1)
    expect(revokeForHandoff).toBeGreaterThan(replacementReady)
    expect(retireWindow).toBeGreaterThan(revokeForHandoff)

    const closed = between(main, "win.on('closed', () => {", "win.webContents.setWindowOpenHandler(")
    const retiredGuard = closed.indexOf('if (win !== self) return')
    const revokeOnCurrentClose = closed.indexOf("commandControl.revokeForLifecycleEvent('window_closed')")
    expect(retiredGuard).toBeGreaterThan(-1)
    expect(revokeOnCurrentClose).toBeGreaterThan(retiredGuard)
  })

  it('keeps the Metis command hotkey separate from meeting Listen', () => {
    expect(ipc).toContain("'metis-command'")
    expect(main).toContain("'metis-command': () => sendHotkey('metis-command')")
    expect(app).toContain("a === 'metis-command'")
    expect(app).toMatch(/else if \(a === 'toggle-listen'\) toggleListen\(\)/)
    expect(app).toMatch(
      /else if \(a === 'metis-command'\) \{\s*rightEdgeDismissalLockRef\.current = reduceRightEdgeDismissalLock\(rightEdgeDismissalLockRef\.current, \{ type: 'metis-command' \}\)\s*setRightEdgeDockDismissed\(false\)\s*dispatchAutoHide\(\{ type: 'reveal-now' \}\)\s*setCollapsed\(false\)\s*\}/
    )
  })

  it('keeps cloud STT transcript-only because renderer PCM has no hardware provenance', () => {
    const callbacks = between(main, 'onFinal: (line) => {', 'onError: (message) => {')
    expect(callbacks).toMatch(/if \(!isCurrentCloudSttOwner\(owner, e\.sender\)\) return/)
    expect(callbacks).toMatch(/e\.sender\.send\(IPC\.cloudSttFinal, line\)/)
    expect(callbacks).toMatch(/e\.sender\.send\(IPC\.cloudSttInterim, \{ channel, text \}\)/)
    expect(callbacks).not.toContain('ingestMetisCommandFromAsr')
    expect(main).not.toContain('ingestMetisCommandFromAsr')
  })

  it('keeps native ASR transcript-only so delayed local decodes cannot command-execute', () => {
    const para = between(main, 'ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(para).toMatch(/p\.speaker === 'you'/)
    expect(para).not.toContain('ingestMetisCommandFromAsr')
    const apple = between(main, 'ipcMain.handle(IPC.appleSpeechFeed', 'ipcMain.handle(IPC.cloudSttStart')
    expect(apple).toMatch(/p\.speaker === 'you'/)
    expect(apple).not.toContain('ingestMetisCommandFromAsr')
  })

  it('does not open a second always-on microphone stream or render its competing status chip', () => {
    expect(app).not.toContain('startMetisCommandEar')
    expect(app).not.toContain('data-metis-command-ear-chip')
    expect(app).not.toContain('CommandListeningPill')
  })

})
