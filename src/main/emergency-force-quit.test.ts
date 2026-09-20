/**
 * emergency-force-quit.test.ts
 *
 * Ctrl+Cmd+Esc is the last thing between a user and a frozen Métis, so pinning its source shape
 * (c-main-fixes.contract.test.ts) is not enough. This runs the ACTUAL function lifted out of index.ts
 * against stubs and a fake clock, because every property that matters here is a timing property:
 * polite first, hard later, and never so polite that a wedged renderer wins.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const indexText = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const indexSource = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true)

function declarationText(name: string): string {
  const declaration = indexSource.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  )
  expect(declaration, `Actual source function ${name} was not found`).toBeDefined()
  return declaration ? declaration.getText(indexSource) : ''
}

function graceMs(): number {
  const match = indexText.match(/const EMERGENCY_FORCE_QUIT_GRACE_MS = (\d+)/)
  expect(match, 'EMERGENCY_FORCE_QUIT_GRACE_MS was not found').not.toBeNull()
  return Number(match?.[1])
}

type Harness = { forceQuit: () => void; calls: string[]; stopped: string[] }

/** Run the real forceQuitMétis + its sidecar teardown with everything they touch stubbed. */
function harness(overrides: { localRuntimeThrows?: boolean } = {}): Harness {
  const calls: string[] = []
  const stopped: string[] = []
  const source = [
    `const EMERGENCY_FORCE_QUIT_GRACE_MS = ${graceMs()}`,
    'let emergencyQuitWatchdog = null',
    declarationText('stopSidecarsForHardExit'),
    declarationText('forceQuitMétis'),
    'globalThis.result = forceQuitMétis'
  ].join('\n')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    mainLog: { warn: (m: string) => calls.push(`log:${m}`) },
    app: {
      quit: () => calls.push('quit'),
      exit: (code: number) => calls.push(`exit:${code}`),
      getPath: () => '/fixture/userData'
    },
    screenPreprocess: { stop: () => stopped.push('screenPreprocess') },
    localRuntime: {
      stop: () => {
        stopped.push('localRuntime')
        if (overrides.localRuntimeThrows) throw new Error('llama kill failed')
      }
    },
    fmRuntime: { stop: () => stopped.push('fmRuntime') },
    setBootPowerSaveBlock: () => stopped.push('bootPowerSaveBlock'),
    endBootWatch: () => stopped.push('endBootWatch')
  })
  vm.runInContext(compiled, context, { timeout: 2_000 })
  return { forceQuit: context.result, calls, stopped }
}

describe('Ctrl+Cmd+Esc escape hatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks politely first, so a healthy renderer still flushes its meeting', () => {
    const h = harness()
    h.forceQuit()
    expect(h.calls).toContain('quit')
    expect(h.calls.some((c) => c.startsWith('exit:'))).toBe(false)
    expect(h.stopped).toEqual([])
  })

  it('outlasts before-quit own 2s flush window before it stops being polite', () => {
    const h = harness()
    h.forceQuit()
    vi.advanceTimersByTime(2000)
    // before-quit re-quits at 2000ms; killing the process at that exact moment would cut a flush that
    // was still running normally.
    expect(h.calls.some((c) => c.startsWith('exit:'))).toBe(false)
  })

  it('hard-exits once the graceful quit has plainly failed to complete', () => {
    const h = harness()
    h.forceQuit()
    vi.advanceTimersByTime(graceMs())
    expect(h.calls).toContain('exit:0')
    // The sidecars go down first: app.exit() never emits will-quit, which normally kills them.
    expect(h.stopped).toEqual([
      'screenPreprocess',
      'localRuntime',
      'fmRuntime',
      'bootPowerSaveBlock',
      'endBootWatch'
    ])
  })

  it('a second press exits immediately instead of waiting out the grace', () => {
    const h = harness()
    h.forceQuit()
    vi.advanceTimersByTime(100)
    h.forceQuit()
    expect(h.calls).toContain('exit:0')
    expect(h.stopped).toContain('localRuntime')
  })

  it('a throwing sidecar kill never stops the process from going down', () => {
    const h = harness({ localRuntimeThrows: true })
    h.forceQuit()
    vi.advanceTimersByTime(graceMs())
    expect(h.stopped).toContain('fmRuntime')
    expect(h.stopped).toContain('endBootWatch')
    expect(h.calls).toContain('exit:0')
  })
})
