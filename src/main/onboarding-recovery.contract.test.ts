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

function topLevelFunctionDeclaration(name: string): ts.FunctionDeclaration | undefined {
  return indexSource.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name
  )
}

function actualFunction(name: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const declaration = topLevelFunctionDeclaration(name)
  expect(declaration, `Actual source function ${name} was not found`).toBeDefined()
  if (!declaration) return () => undefined
  return runSource(`${declaration.getText(indexSource)}\nglobalThis.result = ${name};`, globals)
}

function webContentsOnCallback(target: string, eventName: string, bodyIncludes?: string): ts.Expression | undefined {
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(indexSource) === target &&
      node.expression.name.text === 'on' &&
      node.arguments[0]?.getText(indexSource) === `'${eventName}'`
    ) {
      const candidate = node.arguments[1]
      if (!bodyIncludes || candidate?.getText(indexSource).includes(bodyIncludes)) callback = candidate
    }
    ts.forEachChild(node, visit)
  }
  visit(indexSource)
  return callback
}

function actualRendererRecoveryHandlers(globals: Record<string, unknown>): {
  didFinishLoad: () => void
  renderProcessGone: (...args: any[]) => any
} {
  const didFinishLoad = webContentsOnCallback('self.webContents', 'did-finish-load')
  const renderProcessGone = webContentsOnCallback('win.webContents', 'render-process-gone', 'revokeForLifecycleEvent')
  expect(didFinishLoad, 'Actual overlay did-finish-load handler was not found').toBeDefined()
  expect(renderProcessGone, 'Actual overlay render-process-gone handler was not found').toBeDefined()
  if (!didFinishLoad || !renderProcessGone) {
    return { didFinishLoad: () => undefined, renderProcessGone: () => undefined }
  }
  // The handler's automatic-reload branch calls the real reloadOverlay(...) helper — lift it too, so a
  // reload exercises the shipped loadURL + redact + audit wiring instead of a hand-copied stand-in.
  const reloadOverlayDecl = topLevelFunctionDeclaration('reloadOverlay')
  expect(reloadOverlayDecl, 'Actual source function reloadOverlay was not found').toBeDefined()
  const prefix = reloadOverlayDecl ? `${reloadOverlayDecl.getText(indexSource)}\n` : ''
  return runSource(
    `${prefix}globalThis.result = { didFinishLoad: (${didFinishLoad.getText(indexSource)}), renderProcessGone: (${renderProcessGone.getText(indexSource)}) };`,
    globals
  )
}

function actualRendererGoneHandler(globals: Record<string, unknown>): (...args: any[]) => any {
  return actualRendererRecoveryHandlers(globals).renderProcessGone
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
    const showRenderLoopHaltedDialog = vi.fn().mockResolvedValue(undefined)
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

  it('resets the reload budget after did-finish-load stays alive for 30s', () => {
    let t = 0
    const showRenderLoopHaltedDialog = vi.fn().mockResolvedValue(undefined)
    const { globals, loadURL } = baseGlobals({
      reloadBudget: createReloadBudget(() => t),
      requireAuth: () => true,
      showRenderLoopHaltedDialog
    })
    const { didFinishLoad, renderProcessGone } = actualRendererRecoveryHandlers(globals)

    renderProcessGone({}, { reason: 'crashed', exitCode: 1 })
    t = 1
    renderProcessGone({}, { reason: 'crashed', exitCode: 1 })
    t = 2
    renderProcessGone({}, { reason: 'crashed', exitCode: 1 })
    expect(loadURL).toHaveBeenCalledTimes(3)

    t = 3
    didFinishLoad()
    t = 30_003
    renderProcessGone({}, { reason: 'crashed', exitCode: 1 })

    expect(loadURL).toHaveBeenCalledTimes(4)
    expect(showRenderLoopHaltedDialog).not.toHaveBeenCalled()
  })

  it('a clean exit calls neither loadURL nor the recovery dialog', () => {
    const showRenderLoopHaltedDialog = vi.fn().mockResolvedValue(undefined)
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
    const lockedDialog = vi.fn().mockResolvedValue(undefined)
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
    const unlockedDialog = vi.fn().mockResolvedValue(undefined)
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

describe('onFatal — async relaunch dialog', () => {
  /** Lifts `fatalHandled`, `onFatal` and `showFatalDialog` together so `onFatal` closes over the real
   *  latch and calls the real dialog — a fresh vm context per call, so `fatalHandled` starts false again
   *  for each test. `persistCrash` is injected rather than lifted: this test is about the async-dialog
   *  half of the ticket, and persistCrash's own redact/log/write behaviour has its own coverage. */
  function actualOnFatal(globals: Record<string, unknown>): (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => void {
    const fatalHandledDecl = indexSource.statements.find(
      (node): node is ts.VariableStatement =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'fatalHandled')
    )
    const onFatalDecl = topLevelFunctionDeclaration('onFatal')
    const showFatalDialogDecl = topLevelFunctionDeclaration('showFatalDialog')
    expect(fatalHandledDecl, 'Actual source declaration fatalHandled was not found').toBeDefined()
    expect(onFatalDecl, 'Actual source function onFatal was not found').toBeDefined()
    expect(showFatalDialogDecl, 'Actual source function showFatalDialog was not found').toBeDefined()
    if (!fatalHandledDecl || !onFatalDecl || !showFatalDialogDecl) return () => undefined
    const source = [
      fatalHandledDecl.getText(indexSource),
      onFatalDecl.getText(indexSource),
      showFatalDialogDecl.getText(indexSource),
      'globalThis.result = onFatal;'
    ].join('\n')
    return runSource(source, globals)
  }

  /** A `dialog.showMessageBox` whose promise the test resolves itself, plus the `persistCrash`/`exitAndRelaunch`/`win`
   *  stubs the lifted `onFatal`/`showFatalDialog` need. */
  function pendingDialogGlobals(overrides: Record<string, unknown> = {}) {
    let resolveDialog!: (result: { response: number }) => void
    const showMessageBox = vi.fn(() => new Promise<{ response: number }>((resolve) => { resolveDialog = resolve }))
    const persistCrash = vi.fn()
    const win = {}
    const globals: Record<string, unknown> = {
      persistCrash,
      dialog: { showMessageBox },
      exitAndRelaunch: vi.fn(),
      win,
      ...overrides
    }
    return { globals, showMessageBox, persistCrash, win, resolve: (response: number) => resolveDialog({ response }) }
  }

  it('returns while the relaunch dialog is still pending, parented to win', () => {
    const { globals, showMessageBox, persistCrash, win } = pendingDialogGlobals()
    const onFatal = actualOnFatal(globals)

    onFatal('uncaughtException', new Error('boom'))

    // onFatal is synchronous and returns immediately: showFatalDialog only reaches its first `await` after
    // showMessageBox has already been called, so the assertion below runs before that promise settles.
    expect(persistCrash).toHaveBeenCalledExactlyOnceWith('uncaughtException', expect.stringContaining('boom'), 'boom')
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(win, expect.objectContaining({ buttons: ['Relaunch Métis', 'Continue'] }))
  })

  it('calls exitAndRelaunch when the user picks "Relaunch Métis" (response 0)', async () => {
    const exitAndRelaunch = vi.fn()
    const { globals, resolve } = pendingDialogGlobals({ exitAndRelaunch })
    const onFatal = actualOnFatal(globals)

    onFatal('uncaughtException', new Error('boom'))
    resolve(0)
    await new Promise((r) => setImmediate(r))

    expect(exitAndRelaunch).toHaveBeenCalledOnce()
  })

  it('does not call exitAndRelaunch when the user picks "Continue" (response 1)', async () => {
    const exitAndRelaunch = vi.fn()
    const { globals, resolve } = pendingDialogGlobals({ exitAndRelaunch })
    const onFatal = actualOnFatal(globals)

    onFatal('uncaughtException', new Error('boom'))
    resolve(1)
    await new Promise((r) => setImmediate(r))

    expect(exitAndRelaunch).not.toHaveBeenCalled()
  })

  it('a second uncaughtException calls persistCrash again but opens no second dialog', () => {
    const { globals, showMessageBox, persistCrash } = pendingDialogGlobals()
    const onFatal = actualOnFatal(globals)

    onFatal('uncaughtException', new Error('first'))
    onFatal('uncaughtException', new Error('second'))

    expect(persistCrash).toHaveBeenCalledTimes(2)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('an unhandledRejection persists the crash but never opens the dialog', () => {
    const { globals, showMessageBox, persistCrash } = pendingDialogGlobals()
    const onFatal = actualOnFatal(globals)

    onFatal('unhandledRejection', 'a rejected promise reason')

    expect(persistCrash).toHaveBeenCalledExactlyOnceWith('unhandledRejection', 'a rejected promise reason', 'a rejected promise reason')
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
