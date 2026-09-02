import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MQA-176 — "Hide from screen capture" (settings.contentProtection; the bar's eye button and
 * Settings → Privacy) is what puts WDA_EXCLUDEFROMCAPTURE on Métis's windows. Live measurement on the
 * shipped 1.5.4 Windows build read GetWindowDisplayAffinity == 17 on the overlay and confirmed a
 * cross-process SetWindowDisplayAffinity(hwnd, WDA_NONE) returns FALSE — the exclusion works, and the
 * only thing that can change it is this process.
 *
 * That makes this app the entire trust boundary, in BOTH directions:
 *   - ON must reach every window actually on screen, including one opened later (the Intelligence
 *     dashboard) and one rebuilt after a crash (the overlay), or a user who believes they are hidden
 *     is being screen-shared.
 *   - OFF must reach them just as reliably. Private View defaults ON, so a window that stayed stuck ON
 *     would be a window the user cannot make visible again.
 *
 * The source audit below is what covers "windows added later" in the code sense: it holds the
 * invariant over EVERY `new BrowserWindow` in src/main, not over the four that exist today.
 */

const MAIN_DIR = __dirname
const indexSrc = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test
 *  so one drifted marker reports as its own failure instead of aborting the whole file. */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = source.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return source.slice(start, end)
}

// ── The invariant: no window reaches the screen without a capture decision ────────────────────────

/** Every `new BrowserWindow(...)` in the main process, with the variable it is assigned to. */
const NEW_WINDOW = /(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*new BrowserWindow\(/g

/** Substring from the `{` at `open` through its matching `}`. These option literals contain no braces
 *  inside strings, so plain counting is exact. */
function braceBlock(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

interface WindowAudit {
  /** `file: variable` for every constructed window — asserted explicitly below so a regex that stopped
   *  matching can never let this suite pass vacuously. */
  windows: string[]
  /** Windows composited to the screen that never get a setContentProtection() decision. */
  violations: string[]
}

/**
 * A window is acceptable when it is either
 *   - constructed with `show: false` (a hidden worker/print window — never composited, so no capture
 *     path can reach it), or
 *   - passed to `<var>.setContentProtection(...)` at or after its own construction site.
 * Anything else is a visible window the Private View toggle does not control.
 */
function auditWindows(files: { file: string; source: string }[]): WindowAudit {
  const windows: string[] = []
  const violations: string[] = []
  for (const { file, source } of files) {
    for (const match of source.matchAll(NEW_WINDOW)) {
      const target = match[1]
      windows.push(`${file}: ${target}`)
      const open = source.indexOf('{', (match.index ?? 0) + match[0].length - 1)
      const options = open === -1 ? '' : braceBlock(source, open)
      if (/\bshow:\s*false\b/.test(options)) continue
      // Search from the construction site FORWARD only. A setContentProtection() that appears EARLIER in
      // the module belongs to a re-sync helper (syncIntelContentProtection), and that helper only runs on
      // the NEXT settings save — until then the window is already on screen and capturable. Accepting it
      // would let the audit pass on the exact regression it exists to catch.
      if (new RegExp(`(?<![\\w$])${target}\\.setContentProtection\\(`).test(source.slice(match.index ?? 0)))
        continue
      violations.push(`${file}: ${target}`)
    }
  }
  return { windows, violations }
}

/** Every non-test .ts under src/main. Only the main process can construct a BrowserWindow, so this is
 *  the complete set of places a new window can appear. */
function mainSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry))
        out.push({ file: relative(MAIN_DIR, full).replace(/\\/g, '/'), source: readFileSync(full, 'utf8') })
    }
  }
  walk(MAIN_DIR)
  return out
}

describe('MQA-176 — every window Métis puts on screen is covered by the Private View toggle', () => {
  it('MQA-176 — no visible window is constructed without a setContentProtection decision', () => {
    const audit = auditWindows(mainSources())
    // The four that exist today: the overlay and the Intelligence dashboard are visible and protected;
    // the import decoder and the recap-PDF printer are `show: false` and never composited.
    expect(audit.windows.sort()).toEqual([
      'index.ts: decoderWin',
      'index.ts: hideParkWin',
      'index.ts: pdfWin',
      'index.ts: win',
      'intelligence.ts: intelWin'
    ])
    expect(audit.violations).toEqual([])
  })

  it('MQA-176 — the audit rejects a NEW visible window that forgets Private View', () => {
    // The regression this pin exists for: a window added later (here a plausible "meeting history"
    // window) that is never wired to contentProtection, so it stays screen-shareable while the eye
    // button still reports hidden.
    const added = `
function openHistoryWindow(): void {
  historyWin = new BrowserWindow({ width: 900, height: 700, title: 'Meeting history' })
  historyWin.loadFile(join(__dirname, '../renderer/history.html'))
}
`
    expect(auditWindows([{ file: 'index.ts', source: indexSrc + added }]).violations).toEqual([
      'index.ts: historyWin'
    ])
  })

  it('MQA-176 — the audit clears that same window once it is hidden, or once it is protected', () => {
    const hidden = `
  historyWin = new BrowserWindow({ show: false, width: 900, height: 700 })
`
    const guarded = `
  historyWin = new BrowserWindow({ width: 900, height: 700 })
  historyWin.setContentProtection(contentProtectionOn())
`
    expect(auditWindows([{ file: 'index.ts', source: indexSrc + hidden }]).violations).toEqual([])
    expect(auditWindows([{ file: 'index.ts', source: indexSrc + guarded }]).violations).toEqual([])
  })

  it('MQA-176 — the audit fires if the DASHBOARD stops applying it at construction', () => {
    // The other half of "windows created later": the dashboard is opened from a menu long after boot, so
    // its own construction-time call is the ONLY thing that decides its capture state. The re-sync helper
    // (syncIntelContentProtection) is not a substitute — it runs on the NEXT settings save, and until the
    // user happens to save something the dashboard is on screen, capturable, while the toggle reads "on".
    // So a module that still MENTIONS intelWin.setContentProtection() in that helper must not clear the audit.
    const intelSrc = readFileSync(join(MAIN_DIR, 'intelligence.ts'), 'utf8')
    // Regex, not a literal slice: intelligence.ts is CRLF in the tree while index.ts is LF.
    const stripped = intelSrc.replace(/\n[ \t]*intelWin\.setContentProtection\(intelCpOn\(\)\)/, '')
    expect(stripped, 'the line the dashboard depends on moved — update this pin').not.toBe(intelSrc)
    expect(stripped).toContain('syncIntelContentProtection') // the helper's mention survives, on purpose
    expect(auditWindows([{ file: 'intelligence.ts', source: stripped }]).violations).toEqual([
      'intelligence.ts: intelWin'
    ])
  })

  it('MQA-176 — the audit fires if the overlay itself stops applying it at construction', () => {
    // Deleting that one call is exactly the "a rebuilt window comes back capturable" shape:
    // ensureWindow() / second-instance / the boot retry all rebuild the overlay through createWindow(),
    // and the `win?.setContentProtection(...)` calls in the IPC handlers only run on the NEXT save.
    const stripped = indexSrc.replace('\n  win.setContentProtection(contentProtectionOn())', '')
    expect(stripped, 'the line the overlay depends on moved — update this pin').not.toBe(indexSrc)
    expect(auditWindows([{ file: 'index.ts', source: stripped }]).violations).toEqual(['index.ts: win'])
  })
})

// ── The overlay: the decision itself, and every place it is re-applied ────────────────────────────

type DevEnv = (name: string) => string | undefined
/** What devEnv() returns in a packaged build: nothing, whatever the environment says. */
const packagedDevEnv: DevEnv = () => undefined
const unpackagedDevEnv: DevEnv = (name) => process.env[name]

describe('MQA-176 — contentProtectionOn() is the single decision, and it is honest in both directions', () => {
  /** Lift contentProtectionOn's real body out of index.ts and run it. index.ts boots Electron at import
   *  time, so this is the established pattern here (dev-env-gates.contract.test.ts et al). */
  const contentProtectionOn = (devEnv: DevEnv, contentProtection: boolean): boolean => {
    const src = sliceBetween(indexSrc, 'function contentProtectionOn(): boolean {', '\n}')
    const body = src.slice(src.indexOf('{') + 1)
    const lifted = new Function('devEnv', 'getSettings', body) as (
      devEnv: DevEnv,
      getSettings: () => { contentProtection: boolean }
    ) => boolean
    return lifted(devEnv, () => ({ contentProtection }))
  }

  afterEach(() => {
    delete process.env.ASKTOTO_DISABLE_CP
  })

  it('MQA-176 — a packaged build keeps the exclusion even with ASKTOTO_DISABLE_CP set', () => {
    // The shipped-1.5.4 observation that read as an anomaly: the hatch has been gated to unpackaged
    // builds since 2026-07-06, so affinity staying at WDA_EXCLUDEFROMCAPTURE is the gate holding, not a
    // failure to apply. `setx ASKTOTO_DISABLE_CP 1` + relaunch needs no elevation, which is why.
    process.env.ASKTOTO_DISABLE_CP = '1'
    expect(contentProtectionOn(packagedDevEnv, true)).toBe(true)
  })

  it('MQA-176 — an unpackaged dev/screenshot run still honours the hatch', () => {
    process.env.ASKTOTO_DISABLE_CP = '1'
    expect(contentProtectionOn(unpackagedDevEnv, true)).toBe(false)
  })

  it('MQA-176 — turning the toggle OFF really returns false, so the overlay can be seen again', () => {
    // The other half of the promise: Private View defaults ON, so nothing may make it un-turn-off-able.
    expect(contentProtectionOn(packagedDevEnv, false)).toBe(false)
  })

  it('MQA-176 — a rebuilt overlay re-applies the decision at construction', () => {
    const createWindow = sliceBetween(indexSrc, 'function createWindow(): void {', 'function resizeTo(')
    expect(createWindow).toContain('win.setContentProtection(contentProtectionOn())')
  })

  it('MQA-176 — saving the toggle re-applies it to BOTH live windows', () => {
    const settingsSet = sliceBetween(
      indexSrc,
      'ipcMain.handle(IPC.settingsSet',
      'ipcMain.handle(IPC.settingsRecoverProfile'
    )
    expect(settingsSet).toContain('win?.setContentProtection(contentProtectionOn())')
    expect(settingsSet).toContain('syncIntelContentProtection()')
  })

  it('MQA-176 — an IT-managed change re-applies it to BOTH live windows without a restart', () => {
    const settingsGet = sliceBetween(indexSrc, 'ipcMain.handle(IPC.settingsGet', 'ipcMain.handle(IPC.permissionsGet')
    expect(settingsGet).toContain('win?.setContentProtection(contentProtectionOn())')
    expect(settingsGet).toContain('syncIntelContentProtection()')
  })
})

// ── The dashboard: the window that is created LATER ───────────────────────────────────────────────

const stored = vi.hoisted(() => ({ contentProtection: true }))
vi.mock('electron')
vi.mock('./store', () => ({ getSettings: () => stored }))

interface FakeWindow {
  isDestroyed: () => boolean
  destroy: () => void
  setContentProtection: ReturnType<typeof vi.fn>
}

describe('MQA-176 — the Intelligence dashboard is created with the CURRENT Private View state', () => {
  let bundle: string
  let built: FakeWindow[]

  beforeEach(async () => {
    vi.resetModules()
    built = []
    stored.contentProtection = true
    // bundleIndexHtml() probes resourcesPath first — a fixture there opens the window without needing a
    // built intelligence/dist in the tree.
    bundle = mkdtempSync(join(tmpdir(), 'asktoto-cp-'))
    mkdirSync(join(bundle, 'intelligence'), { recursive: true })
    writeFileSync(join(bundle, 'intelligence', 'index.html'), '<!doctype html>', 'utf8')
    ;(process as unknown as { resourcesPath?: string }).resourcesPath = bundle

    const electron = await import('electron')
    ;(electron.app as unknown as { getAppPath: () => string }).getAppPath = () => bundle
    ;(electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      const listeners: Record<string, () => void> = {}
      let destroyed = false
      const win = {
        isDestroyed: (): boolean => destroyed,
        destroy: (): void => {
          destroyed = true
          listeners.closed?.()
        },
        setContentProtection: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        on: (event: string, fn: () => void): void => {
          listeners[event] = fn
        },
        loadFile: vi.fn(() => Promise.resolve()),
        webContents: {
          setWindowOpenHandler: vi.fn(),
          on: vi.fn(),
          getURL: () => pathToFileURL(join(bundle, 'intelligence', 'index.html')).href
        }
      }
      built.push(win as unknown as FakeWindow)
      return win
    })
  })

  afterEach(async () => {
    rmSync(bundle, { recursive: true, force: true })
    delete (process as unknown as { resourcesPath?: string }).resourcesPath
    delete ((await import('electron')).app as { isPackaged?: boolean }).isPackaged
    delete process.env.ASKTOTO_DISABLE_CP
  })

  it('MQA-176 — a dashboard opened AFTER the toggle is already on is excluded from capture', async () => {
    const intel = await import('./intelligence')
    expect(intel.openIntelligenceWindow()).toEqual({ ok: true })
    expect(built).toHaveLength(1)
    expect(built[0].setContentProtection).toHaveBeenCalledWith(true)
  })

  it('MQA-176 — a dashboard opened while the toggle is OFF is left capturable', async () => {
    stored.contentProtection = false
    const intel = await import('./intelligence')
    intel.openIntelligenceWindow()
    expect(built[0].setContentProtection).toHaveBeenCalledWith(false)
  })

  it('MQA-176 — flipping the toggle reaches a dashboard that is ALREADY open', async () => {
    const intel = await import('./intelligence')
    intel.openIntelligenceWindow()
    stored.contentProtection = false
    intel.syncIntelContentProtection()
    expect(built[0].setContentProtection).toHaveBeenLastCalledWith(false)
    stored.contentProtection = true
    intel.syncIntelContentProtection()
    expect(built[0].setContentProtection).toHaveBeenLastCalledWith(true)
  })

  it('MQA-176 — a dashboard REBUILT after being torn down comes back with the current state', async () => {
    // Sign-out destroys this window (MQA-169). Reopening must re-decide, not inherit — the same
    // durability across a rebuild that the overlay gets from createWindow().
    const intel = await import('./intelligence')
    intel.openIntelligenceWindow()
    intel.closeIntelligenceWindow()
    stored.contentProtection = false
    expect(intel.openIntelligenceWindow()).toEqual({ ok: true })
    expect(built).toHaveLength(2)
    expect(built[1].setContentProtection).toHaveBeenCalledWith(false)
  })

  it('MQA-176 — ASKTOTO_DISABLE_CP cannot strip the dashboard either in a packaged build', async () => {
    // The dashboard aggregates the most sensitive cross-meeting data, so its gate must match the
    // overlay's. Same threat: a planted user-scoped env var plus one relaunch, no elevation needed.
    const electron = await import('electron')
    ;(electron.app as { isPackaged?: boolean }).isPackaged = true
    process.env.ASKTOTO_DISABLE_CP = '1'
    const intel = await import('./intelligence')
    intel.openIntelligenceWindow()
    expect(built[0].setContentProtection).toHaveBeenCalledWith(true)
  })
})
