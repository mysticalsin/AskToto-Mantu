import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

vi.mock('electron')

/**
 * Sign-out has to revoke the WHOLE privileged surface, not the parts one handler happened to remember.
 * Two findings, one gap: MQA-154 (background screen pre-analysis kept capturing + describing for a
 * signed-out user) and MQA-169 (the Mantu Intelligence dashboard kept rendering the decrypted brain).
 * Both are pinned here because both are torn down by ONE hook — auth.ts's session-cleared handler,
 * which fires from clearSession(), the single funnel every path goes through: the deliberate sign-out,
 * the max-age eviction, and the background re-validation sweep's expiry/revocation. The last two never
 * touch an IPC handler at all, which is why pinning only the IPC boundary would not have held.
 */

/** A session file the real loadSession() will accept, aged `agedMs` into the past. */
async function writeSessionFile(userData: string, agedMs: number): Promise<void> {
  const { encryptSecret } = await import('./secrets')
  const session = { email: 'user@mantu.com', domain: 'mantu.com', tid: 'tid', at: Date.now() - agedMs }
  writeFileSync(join(userData, 'auth-session.bin'), encryptSecret(JSON.stringify(session)), { mode: 0o600 })
}

describe('auth.ts — every session-clearing path runs main\'s revoke', () => {
  let userData: string

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-signout-revoke-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('MQA-154 — signOut() runs the registered revoke, so no privileged surface outlives the session', async () => {
    await writeSessionFile(userData, 0)
    const auth = await import('./auth')
    const revoke = vi.fn()
    auth.setSessionClearedHandler(revoke)

    expect(auth.authStatus().signedIn).toBe(true)
    auth.signOut()

    expect(revoke).toHaveBeenCalledTimes(1)
    expect(auth.authStatus().signedIn).toBe(false)
  })

  it('MQA-169 — an expired session revokes with no user action (that path reaches no IPC handler)', async () => {
    await writeSessionFile(userData, 8 * 24 * 60 * 60 * 1000) // past MAX_SESSION_AGE_MS (7 days)
    const auth = await import('./auth')
    const revoke = vi.fn()
    auth.setSessionClearedHandler(revoke)

    expect(auth.authStatus().signedIn).toBe(false) // evicted on read
    expect(revoke).toHaveBeenCalled()
  })

  it('MQA-154 — a throwing revoke never blocks the session from being cleared', async () => {
    await writeSessionFile(userData, 0)
    const auth = await import('./auth')
    auth.setSessionClearedHandler(() => {
      throw new Error('window already gone')
    })

    expect(() => auth.signOut()).not.toThrow()
    expect(auth.authStatus().signedIn).toBe(false)
  })
})

interface FakeWindow {
  destroyed: boolean
  webContents: { getURL: () => string }
}

describe('intelligence.ts — the dashboard window is revocable', () => {
  let userData: string
  let win: FakeWindow

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-intel-revoke-'))
    mkdirSync(join(userData, 'intelligence'), { recursive: true })
    writeFileSync(join(userData, 'intelligence', 'index.html'), '<!doctype html>', 'utf8')
    // bundleIndexHtml() probes resourcesPath first, then two dev locations — point the packaged
    // candidate at the fixture so the window opens without a built intelligence/dist in the tree.
    ;(process as unknown as { resourcesPath?: string }).resourcesPath = userData

    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(electron.app as unknown as { getAppPath: () => string }).getAppPath = () => userData
    ;(electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      const listeners: Record<string, () => void> = {}
      const url = pathToFileURL(join(userData, 'intelligence', 'index.html')).href
      win = {
        destroyed: false,
        isDestroyed(): boolean {
          return win.destroyed
        },
        destroy(): void {
          win.destroyed = true
          listeners.closed?.()
        },
        show: vi.fn(),
        focus: vi.fn(),
        setContentProtection: vi.fn(),
        on: (event: string, fn: () => void): void => {
          listeners[event] = fn
        },
        loadFile: vi.fn(() => Promise.resolve()),
        webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), getURL: () => url }
      } as unknown as FakeWindow
      return win
    })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    delete (process as unknown as { resourcesPath?: string }).resourcesPath
    vi.restoreAllMocks()
  })

  it('MQA-169 — closeIntelligenceWindow destroys the dashboard and revokes its brain-read grant', async () => {
    const intel = await import('./intelligence')
    expect(intel.openIntelligenceWindow()).toEqual({ ok: true })
    const sender = win.webContents as unknown as Electron.WebContents
    expect(intel.isIntelligenceSender(sender)).toBe(true)

    intel.closeIntelligenceWindow()

    expect(win.destroyed).toBe(true)
    expect(intel.isIntelligenceSender(sender)).toBe(false) // brain:read/brain:status now fail closed
  })

  it('MQA-169 — revoking with no dashboard open is a no-op', async () => {
    const intel = await import('./intelligence')
    expect(() => intel.closeIntelligenceWindow()).not.toThrow()
  })
})

/**
 * index.ts boots Electron at import time and both surfaces are closures inside it, so the wiring is
 * pinned against the source — the established pattern here (c-main-fixes.contract.test.ts,
 * index-audit-fixes.contract.test.ts). What matters is that ONE function tears both down and that it
 * is the thing auth calls, so the next background surface is added in a place that already dies.
 */
describe('index.ts — one revoke covers the whole privileged surface', () => {
  const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

  const revokeBody = (): string => {
    const start = indexSrc.indexOf('function revokePrivilegedSurface')
    expect(start, 'no revokePrivilegedSurface() in index.ts').toBeGreaterThan(-1)
    const end = indexSrc.indexOf('\n}', start)
    expect(end).toBeGreaterThan(start)
    return indexSrc.slice(start, end)
  }

  it('MQA-154 — the session revoke stops background screen pre-analysis', () => {
    expect(revokeBody()).toContain('refreshScreenPreprocess()')
  })

  it('MQA-169 — the session revoke closes the Mantu Intelligence dashboard window', () => {
    expect(revokeBody()).toContain('closeIntelligenceWindow()')
  })

  it('MQA-154 — the revoke is registered on auth\'s session-cleared hook, not on one IPC handler', () => {
    expect(indexSrc).toMatch(/setSessionClearedHandler\(revokePrivilegedSurface\)/)
  })
})
