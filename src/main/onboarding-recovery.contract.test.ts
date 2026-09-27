import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { redactSecrets } from '@shared/redact'
import { createReloadBudget } from './lifecycle/reload-budget'

const indexText = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const indexSource = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true)

function runSource(sourceText: string, globals: Record<string, unknown>): any {
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext({
    URL,
    URLSearchParams,
    // Shares this realm's Error with the lifted code: vm.createContext() otherwise gives the sandbox its
    // own fresh intrinsics, so an outer-realm Error (e.g. a rejected mock's Error) would fail an
    // `err instanceof Error` check inside the sandbox even though it really is one.
    Error,
    ...globals
  })
  vm.runInContext(compiled, context, { timeout: 2_000 })
  return context.result
}

function actualFunction(name: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const declaration = indexSource.statements.find(
    node => ts.isFunctionDeclaration(node) && node.name?.text === name
  )
  expect(declaration, `Actual source function ${name} was not found`).toBeDefined()
  if (!declaration) return () => undefined
  return runSource(`${declaration.getText(indexSource)}\nglobalThis.result = ${name};`, globals)
}

function actualRendererGoneHandler(globals: Record<string, unknown>): (...args: any[]) => any {
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(indexSource) === 'win.webContents' &&
      node.expression.name.text === 'on' &&
      node.arguments[0]?.getText(indexSource) === "'render-process-gone'"
    ) callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(indexSource)
  expect(callback, 'Actual overlay render-process-gone handler was not found').toBeDefined()
  if (!callback) return () => undefined
  // The handler's automatic-reload branch calls the real reloadOverlay(...) helper — lift it too, so a
  // reload exercises the shipped loadURL + redact + audit wiring instead of a hand-copied stand-in.
  const reloadOverlayDecl = indexSource.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'reloadOverlay'
  )
  expect(reloadOverlayDecl, 'Actual source function reloadOverlay was not found').toBeDefined()
  const prefix = reloadOverlayDecl ? `${reloadOverlayDecl.getText(indexSource)}\n` : ''
  return runSource(`${prefix}globalThis.result = (${callback.getText(indexSource)});`, globals)
}

describe('exclusive onboarding renderer recovery', () => {
  it('reloads an exclusive onboarding renderer with the parser-time shell flag', () => {
    const recoveryUrl = actualFunction('overlayRendererUrl', {
      __dirname: '/fixture',
      join: (...parts: string[]) => parts.join('/'),
      pathToFileURL: (path: string) => ({ href: `file://${path}` }),
      onboardingExclusiveLive: () => true,
      devEnv: () => undefined,
      process: { env: {} }
    })()

    expect(recoveryUrl).toBe('file:///renderer/index.html?exclusiveOnboarding=1')

    // Real BrowserWindow#loadURL returns a Promise; M2-0037 now observes it (`.catch(...)` on the result).
    const loadURL = vi.fn(() => Promise.resolve())
    const revokeForLifecycleEvent = vi.fn()
    const win = {
      isDestroyed: () => false,
      loadURL,
      webContents: {}
    }
    const showForExclusiveOnboarding = vi.fn()
    const applyExclusiveOnboardingStage = vi.fn(() => true)
    const gone = actualRendererGoneHandler({
      mainLog: { error: vi.fn() },
      auditLog: vi.fn(),
      resetDustConversation: vi.fn(),
      discardActiveLiveSpeakerSession: vi.fn(),
      invalidateCloudSttOwner: vi.fn(),
      setTrayRecording: vi.fn(),
      setRecordingPowerSaveBlock: vi.fn(),
      applyExclusiveOnboardingStage,
      showForExclusiveOnboarding,
      onboardingExclusiveLive: () => true,
      overlayRendererUrl: () => recoveryUrl,
      redactSecrets,
      listeningActive: true,
      lastPlainAskAt: 1,
      audioArmed: true,
      isMinimized: true,
      currentWidth: 1,
      BAR_WIDTH: 600,
      self: win,
      // Captured beside `const self = win`, outside this handler: reading self.webContents here would
      // throw against an already-torn-down WebContents (MQA-340).
      selfWebContentsId: 1,
      commandControl: { revokeForLifecycleEvent },
      responsiveness: { markGone: vi.fn() },
      // M2-0037: within budget — the handler must still reload exactly as before.
      reloadBudget: { onRenderProcessGone: () => 'reload' },
      win
    })

    gone({}, { reason: 'crashed', exitCode: 1 })

    expect(applyExclusiveOnboardingStage).toHaveBeenCalledExactlyOnceWith(win)
    expect(showForExclusiveOnboarding).toHaveBeenCalledExactlyOnceWith(win)
    expect(loadURL).toHaveBeenCalledExactlyOnceWith(recoveryUrl)
    expect(revokeForLifecycleEvent).toHaveBeenCalledExactlyOnceWith('renderer_replaced')
  })
})

describe('render-process-gone reload budget wiring', () => {
  /** Stubs every scenario below needs; each test supplies `reloadBudget` and overrides only what it tests. */
  function baseGlobals(overrides: Record<string, unknown>) {
    const loadURL = vi.fn(() => Promise.resolve())
    const win = { isDestroyed: () => false, loadURL, webContents: {} }
    const auditLog = vi.fn()
    const mainLog = { error: vi.fn(), warn: vi.fn() }
    const globals: Record<string, unknown> = {
      mainLog,
      auditLog,
      resetDustConversation: vi.fn(),
      discardActiveLiveSpeakerSession: vi.fn(),
      invalidateCloudSttOwner: vi.fn(),
      setTrayRecording: vi.fn(),
      setRecordingPowerSaveBlock: vi.fn(),
      onboardingExclusiveLive: () => false,
      overlayRendererUrl: () => 'file:///renderer/index.html',
      redactSecrets,
      listeningActive: true,
      lastPlainAskAt: 1,
      audioArmed: true,
      isMinimized: true,
      currentWidth: 1,
      BAR_WIDTH: 600,
      self: win,
      selfWebContentsId: 1,
      commandControl: { revokeForLifecycleEvent: vi.fn() },
      responsiveness: { markGone: vi.fn() },
      win,
      ...overrides
    }
    return { globals, win, loadURL, auditLog, mainLog }
  }

  it('reloads within budget, then halts and opens the recovery surface on the 4th crash inside 60s', () => {
    let t = 0
    const showRenderLoopHaltedDialog = vi.fn()
    const { globals, loadURL, auditLog } = baseGlobals({
      reloadBudget: createReloadBudget(() => t),
      requireAuth: () => true,
      showRenderLoopHaltedDialog
    })
    const gone = actualRendererGoneHandler(globals)

    gone({}, { reason: 'crashed', exitCode: 1 })
    t = 1
    gone({}, { reason: 'crashed', exitCode: 1 })
    t = 2
    gone({}, { reason: 'crashed', exitCode: 1 })
    expect(loadURL).toHaveBeenCalledTimes(3)
    expect(showRenderLoopHaltedDialog).not.toHaveBeenCalled()

    t = 3
    gone({}, { reason: 'crashed', exitCode: 1 })

    // The budget halted — the 4th crash inside the 60s window must not reload.
    expect(loadURL).toHaveBeenCalledTimes(3)
    expect(auditLog).toHaveBeenCalledWith('app.render_loop_halted', { reason: 'crashed', exitCode: 1 })
    expect(showRenderLoopHaltedDialog).toHaveBeenCalledTimes(1)
    expect(showRenderLoopHaltedDialog.mock.calls[0][0]).toBe('crashed')
    expect(showRenderLoopHaltedDialog.mock.calls[0][1]).toBe(1)
  })

  it('a clean exit calls neither loadURL nor the recovery dialog', () => {
    const showRenderLoopHaltedDialog = vi.fn()
    const { globals, loadURL } = baseGlobals({
      reloadBudget: { onRenderProcessGone: () => 'ignore' },
      showRenderLoopHaltedDialog
    })

    actualRendererGoneHandler(globals)({}, { reason: 'clean-exit', exitCode: 0 })

    expect(loadURL).not.toHaveBeenCalled()
    expect(showRenderLoopHaltedDialog).not.toHaveBeenCalled()
  })

  it('a rejected reload is caught, redacted and audited as a crash — never an unhandled rejection', async () => {
    const { globals, loadURL, auditLog, mainLog } = baseGlobals({
      reloadBudget: { onRenderProcessGone: () => 'reload' }
    })
    loadURL.mockImplementation(() => Promise.reject(new Error('offline near sk-ant-abcdefghijklmnopqrstuvwxyz1234567890')))

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      actualRendererGoneHandler(globals)({}, { reason: 'crashed', exitCode: 1 })
      // The .catch() is already attached synchronously above; let its microtask run before asserting.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', unhandled)
    }

    expect(unhandled).not.toHaveBeenCalled()
    expect(mainLog.error).toHaveBeenCalledWith('[renderer-gone] reload failed:', 'offline near [redacted key]')
    expect(auditLog).toHaveBeenCalledWith('app.crash', {
      kind: 'render-process-gone-reload-failed',
      message: 'offline near [redacted key]'
    })
  })

  it("gates the halted dialog's 'Open meetings folder' action on requireAuth(), matching IPC.openPath", async () => {
    const shellOpenPath = vi.fn(() => Promise.resolve(''))
    const getSettings = vi.fn(() => ({ meetingsFolder: '/meetings' }))
    const resolveMeetingsFolder = vi.fn(() => '/meetings/resolved')

    // Locked session: no button rather than one whose click would silently do nothing.
    const lockedDialog = vi.fn()
    const { globals: lockedGlobals } = baseGlobals({
      reloadBudget: { onRenderProcessGone: () => 'halt' },
      requireAuth: () => false,
      showRenderLoopHaltedDialog: lockedDialog,
      shell: { openPath: shellOpenPath },
      getSettings,
      resolveMeetingsFolder
    })
    actualRendererGoneHandler(lockedGlobals)({}, { reason: 'crashed', exitCode: 1 })
    expect(lockedDialog.mock.calls[0][4].openMeetingsFolder).toBeUndefined()

    // Authorized session: the button's action really does shell.openPath(resolveMeetingsFolder(getSettings())).
    const unlockedDialog = vi.fn()
    const { globals: unlockedGlobals } = baseGlobals({
      reloadBudget: { onRenderProcessGone: () => 'halt' },
      requireAuth: () => true,
      showRenderLoopHaltedDialog: unlockedDialog,
      shell: { openPath: shellOpenPath },
      getSettings,
      resolveMeetingsFolder
    })
    actualRendererGoneHandler(unlockedGlobals)({}, { reason: 'crashed', exitCode: 1 })
    const actions = unlockedDialog.mock.calls[0][4]
    // Not toBeInstanceOf(Function): the lifted code's closure is a Function from the vm sandbox's own
    // realm, not this file's — typeof is realm-agnostic.
    expect(typeof actions.openMeetingsFolder).toBe('function')

    await actions.openMeetingsFolder()
    expect(getSettings).toHaveBeenCalled()
    expect(resolveMeetingsFolder).toHaveBeenCalledWith({ meetingsFolder: '/meetings' })
    expect(shellOpenPath).toHaveBeenCalledWith('/meetings/resolved')
  })
})
