import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const indexText = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const indexSource = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true)

function runSource(sourceText: string, globals: Record<string, unknown>): any {
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext({
    URL,
    URLSearchParams,
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
  return runSource(`globalThis.result = (${callback.getText(indexSource)});`, globals)
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

    const loadURL = vi.fn()
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
      win
    })

    gone({}, { reason: 'crashed', exitCode: 1 })

    expect(applyExclusiveOnboardingStage).toHaveBeenCalledExactlyOnceWith(win)
    expect(showForExclusiveOnboarding).toHaveBeenCalledExactlyOnceWith(win)
    expect(loadURL).toHaveBeenCalledExactlyOnceWith(recoveryUrl)
    expect(revokeForLifecycleEvent).toHaveBeenCalledExactlyOnceWith('renderer_replaced')
  })
})
