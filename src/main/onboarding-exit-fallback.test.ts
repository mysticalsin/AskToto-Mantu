import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldRecoverCompletedOnboardingExit } from './onboarding-exit-fallback'

const eligible = {
  sameOverlay: true,
  overlayDestroyed: false,
  onboardingLive: false,
  overlayTransparent: false,
  listeningActive: false,
  audioArmed: false,
  cloudSttActive: false
}

const indexText = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const indexSource = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function actualFallbackFunctions(globals: Record<string, unknown>): {
  armCompletedOnboardingExitFallback: (overlay: unknown) => void
  clearCompletedOnboardingExitFallback: (overlay?: unknown) => void
} {
  const names = ['clearCompletedOnboardingExitFallback', 'armCompletedOnboardingExitFallback']
  const declarations = names.map((name) => {
    const declaration = indexSource.statements.find(
      node => ts.isFunctionDeclaration(node) && node.name?.text === name
    )
    expect(declaration, `Actual ${name} function was not found`).toBeDefined()
    return declaration?.getText(indexSource) ?? ''
  })
  const compiled = ts.transpileModule(
    `${declarations.join('\n')}\nglobalThis.result = { armCompletedOnboardingExitFallback, clearCompletedOnboardingExitFallback };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const context = vm.createContext({ setTimeout, clearTimeout, ...globals })
  vm.runInContext(compiled, context, { timeout: 2_000 })
  return context.result as ReturnType<typeof actualFallbackFunctions>
}

describe('completed onboarding exit fallback', () => {
  it('recovers only the opaque setup window after its durable completion', () => {
    expect(shouldRecoverCompletedOnboardingExit(eligible)).toBe(true)
  })

  it.each([
    'sameOverlay',
    'overlayDestroyed',
    'onboardingLive',
    'overlayTransparent',
    'listeningActive',
    'audioArmed',
    'cloudSttActive'
  ] as const)('does not recover when %s invalidates the safe handoff', (field) => {
    const invalid = {
      ...eligible,
      [field]: field === 'sameOverlay' ? false : true
    }
    expect(shouldRecoverCompletedOnboardingExit(invalid)).toBe(false)
  })

  it('runs the actual bounded main-process recovery when the renderer never sends onboarding:exit', async () => {
    const exitExclusiveOnboardingStage = vi.fn()
    const overlay = { isDestroyed: () => false }
    const fallback = actualFallbackFunctions({
      ONBOARDING_EXIT_FALLBACK_MS: 5_000,
      completedOnboardingExitFallback: null,
      shouldRecoverCompletedOnboardingExit,
      win: overlay,
      overlayWindowTransparent: false,
      listeningActive: false,
      audioArmed: false,
      cloudSttIpcOwner: null,
      onboardingExclusiveLive: () => false,
      postOnboardingDestination: 'settings',
      mainLog: { warn: vi.fn() },
      auditLog: vi.fn(),
      exitExclusiveOnboardingStage
    })

    fallback.armCompletedOnboardingExitFallback(overlay)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(exitExclusiveOnboardingStage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exitExclusiveOnboardingStage).toHaveBeenCalledOnce()
  })

  it('cancels the actual fallback when the normal renderer handoff arrives', async () => {
    const exitExclusiveOnboardingStage = vi.fn()
    const overlay = { isDestroyed: () => false }
    const fallback = actualFallbackFunctions({
      ONBOARDING_EXIT_FALLBACK_MS: 5_000,
      completedOnboardingExitFallback: null,
      shouldRecoverCompletedOnboardingExit,
      win: overlay,
      overlayWindowTransparent: false,
      listeningActive: false,
      audioArmed: false,
      cloudSttIpcOwner: null,
      onboardingExclusiveLive: () => false,
      postOnboardingDestination: 'settings',
      mainLog: { warn: vi.fn() },
      auditLog: vi.fn(),
      exitExclusiveOnboardingStage
    })

    fallback.armCompletedOnboardingExitFallback(overlay)
    fallback.clearCompletedOnboardingExitFallback(overlay)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(exitExclusiveOnboardingStage).not.toHaveBeenCalled()
  })
})
