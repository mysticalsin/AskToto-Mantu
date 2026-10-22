import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { flattenSource, sourceIndexOf } from '../../scripts/lib/source-layout'

const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const screenPreprocess = readFileSync(join(__dirname, 'screen-preprocess.ts'), 'utf8')

function between(source: string, start: string, end: string): string {
  const from = sourceIndexOf(source, start)
  const to = sourceIndexOf(source, end, from + 1)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function expectBefore(source: string, first: string, second: string): void {
  const firstIndex = sourceIndexOf(source, first)
  const secondIndex = sourceIndexOf(source, second)
  expect(firstIndex).toBeGreaterThanOrEqual(0)
  expect(secondIndex).toBeGreaterThanOrEqual(0)
  expect(firstIndex).toBeLessThan(secondIndex)
}

function importManagerCallback(text: string, name: string): string {
  const source = ts.createSourceFile('main', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const initialize = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'initializeImportJobs'
  )
  const assignments =
    initialize?.body?.statements.filter(
      (node): node is ts.ExpressionStatement =>
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.left.getText(source) === 'importJobs' &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) ?? []
  if (assignments.length !== 1) throw new Error('Expected one actual import manager assignment')
  const assignment = assignments[0].expression as ts.BinaryExpression
  const manager = assignment.right
  if (
    !ts.isNewExpression(manager) ||
    manager.expression.getText(source) !== 'ImportJobManager' ||
    manager.arguments?.length !== 1 ||
    !ts.isObjectLiteralExpression(manager.arguments[0])
  )
    throw new Error('Expected actual import manager options')
  const callbacks = manager.arguments[0].properties.filter(
    (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(source) === name
  )
  if (callbacks.length !== 1 || !ts.isArrowFunction(callbacks[0].initializer))
    throw new Error(`Expected one actual ${name} callback`)
  return callbacks[0].initializer.getText(source)
}

describe('import-memory pressure contract', () => {
  it('defers every unattended local-start entry point before it can start or warm the sidecar', () => {
    const rendererPrewarm = between(index, 'ipcMain.handle(IPC.localPrewarm', '// --- Screen capture ---')
    const earlyEnsure = between(index, 'Overlap local sidecar start', '// Receipt Mode:')
    const bootWarm = between(index, 'const warmLocalIfReady = (): void => {', '// Windows toast attribution:')
    const backgroundVlm = between(screenPreprocess, 'if (!text) {', 'if (!text) return')
    const backgroundVlmStart = between(
      screenPreprocess,
      'async function describeOnce',
      'async function describeForWindow'
    )

    expectBefore(rendererPrewarm, 'speculativeLocalWorkAllowed()', 'void prewarmLocal(')
    expectBefore(earlyEnsure, 'speculativeLocalWorkAllowed()', 'ensureLocalRuntimeStarted(')
    expectBefore(bootWarm, 'speculativeLocalWorkAllowed()', 'void prewarmLocal(')
    expect(bootWarm).not.toContain('provisionLocalModel')
    expectBefore(backgroundVlm, 'allowSpeculativeLocalWork?.() === false', 'describeOnce(shot.image)')
    expect(flattenSource(rendererPrewarm)).toContain(
      flattenSource(
        'prewarmLocal(s.localLlm.modelId, buildPrewarmMessages(text, s), speculativeLocalWorkAllowed)'
      )
    )
    expect(flattenSource(bootWarm)).toContain(
      flattenSource(
        "prewarmLocal(cur.localLlm.modelId, buildPrewarmMessages('warm', cur), speculativeLocalWorkAllowed)"
      )
    )
    expect(earlyEnsure).toContain(
      "ensureLocalRuntimeStarted(s.localLlm.modelId, req.mode === 'vision', speculativeLocalWorkAllowed)"
    )
    expect(backgroundVlmStart).toContain(
      'ensureLocalRuntimeStarted(s.localLlm.modelId, true, deps.allowSpeculativeLocalWork)'
    )
  })

  it('reserves high-tier pressure after digest verification and clears it only after the helper stops', () => {
    const admission = importManagerCallback(index, 'onDecodeAdmission')
    const idle = importManagerCallback(index, 'onIdle')

    expect(admission).toContain('highMemoryWhisperImportReserved = highTierVerified')
    expect(admission).toContain('await isHighTierAsrModelReady()')
    expectBefore(idle, 'stopWhisperHost()', 'highMemoryWhisperImportReserved = false')
    expect(idle).toContain('.finally(() =>')
  })

  it('rejects a disconnected manager assignment or unused idle callback', () => {
    expect(index).toContain('importJobs = new ImportJobManager({')
    expect(() =>
      importManagerCallback(
        index.replace('importJobs = new ImportJobManager({', 'const unused = new ImportJobManager({'),
        'onIdle'
      )
    ).toThrow('Expected one actual import manager assignment')
    expect(index).toContain('onIdle: () => {')
    expect(() => importManagerCallback(index.replace('onIdle: () => {', 'unusedOnIdle: () => {'), 'onIdle')).toThrow(
      'Expected one actual onIdle callback'
    )
  })
})
