import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { UpdateRecapPayloadSchema } from '@shared/ipc'
import { createImportMeetingWriteAdapters } from './import-meeting-write-adapters'
import { ipcModuleSource } from '../../scripts/lib/ipc-module-source'

const mainFile = join(__dirname, 'index.ts')

function importAdapterCall(source: ts.SourceFile): ts.CallExpression {
  const imported = source.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './import-meeting-write-adapters'
  )
  const binding = imported[0]?.importClause
  if (
    imported.length !== 1 ||
    !binding ||
    binding.isTypeOnly ||
    !binding.namedBindings ||
    !ts.isNamedImports(binding.namedBindings) ||
    !binding.namedBindings.elements.some(
      (item) => item.name.text === 'createImportMeetingWriteAdapters' && !item.propertyName && !item.isTypeOnly
    )
  )
    throw new Error('Expected runtime import write adapter binding')
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
  const options = manager.arguments[0]
  const spreads = options.properties.filter(
    (node): node is ts.SpreadAssignment =>
      ts.isSpreadAssignment(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === 'createImportMeetingWriteAdapters'
  )
  if (
    spreads.length !== 1 ||
    options.properties.filter(ts.isSpreadAssignment).length !== 1 ||
    options.properties.some(
      (node) => !ts.isSpreadAssignment(node) && ['saveMeeting', 'updateRecap'].includes(node.name.getText(source))
    )
  )
    throw new Error('Expected unoverridden import write adapter spread')
  const call = spreads[0].expression as ts.CallExpression
  const deps = call.arguments[0]
  const names = ['getSettings', 'saveMeeting', 'updateMeetingRecap']
  if (
    call.arguments.length !== 1 ||
    !deps ||
    !ts.isObjectLiteralExpression(deps) ||
    deps.properties.length !== names.length ||
    !names.every((name) =>
      deps.properties.some((node) => ts.isShorthandPropertyAssignment(node) && node.name.text === name)
    )
  )
    throw new Error('Expected exact import write adapter dependencies')
  const shadows: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      [...names, 'createImportMeetingWriteAdapters'].includes(node.name.getText(source))
    )
      shadows.push(node)
    ts.forEachChild(node, visit)
  }
  if (initialize?.body) visit(initialize.body)
  if (shadows.length) throw new Error('Import write adapter bindings must not be shadowed')
  return call
}

// Execute the real small IPC/preload boundaries without booting Electron or loading user data.
function boundary(
  kind: 'main' | 'preload' | 'import' | 'index',
  globals: Record<string, unknown>
): (...args: any[]) => any {
  const file = kind === 'preload' ? join(__dirname, '../preload/index.ts') : mainFile
  // The recall-update handler moved out of the entry point into the recall IPC module.
  const text = kind === 'main' ? ipcModuleSource('recall-ipc') : readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let callback: ts.Node | undefined
  const inFunction = (node: ts.Node, name: string): boolean => {
    let parent = node.parent
    while (parent) {
      if (ts.isFunctionDeclaration(parent) && parent.name?.text === name) return true
      parent = parent.parent
    }
    return false
  }
  const visit = (node: ts.Node): void => {
    if (
      kind === 'main' &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'ipcMain.handle' &&
      node.arguments[0]?.getText(source) === 'IPC.recallUpdateRecap'
    )
      callback = node.arguments[1]
    if (kind === 'preload' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'recallUpdateRecap') {
      callback = node.initializer
    }
    if (
      kind === 'index' &&
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'save' &&
      inFunction(node, 'wireIntelligenceIndexWork')
    )
      callback = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback && kind !== 'import') throw new Error(`Actual ${kind} recap update boundary not found`)
  const expression =
    kind === 'import' ? `${importAdapterCall(source).getText(source)}.updateRecap` : callback!.getText(source)
  const code = ts.transpileModule(`globalThis.result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext({ createImportMeetingWriteAdapters, saveMeeting: vi.fn(), ...globals })
  vm.runInContext(code, context, { timeout: 1_000 })
  return context.result
}

describe('recap status IPC propagation', () => {
  it.each([
    'complete',
    'incomplete'
  ] as const)('preload forwards explicit %s without adding error content', async (status) => {
    const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true }))
    const update = boundary('preload', { ipcRenderer: { invoke }, IPC: { recallUpdateRecap: 'update' } })
    await update('synthetic.md', 'Notes', status)
    expect(invoke).toHaveBeenCalledWith('update', { file: 'synthetic.md', recap: 'Notes', recapStatus: status })
  })

  it('a legacy manual edit does not invent a completed status', async () => {
    const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true }))
    await boundary('preload', { ipcRenderer: { invoke }, IPC: { recallUpdateRecap: 'update' } })(
      'synthetic.md',
      'Notes'
    )
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ file: 'synthetic.md', recap: 'Notes' })
    expect((invoke.mock.calls[0]?.[1] as { recapStatus?: string }).recapStatus).toBeUndefined()
  })

  it.each([
    'complete',
    'incomplete'
  ] as const)('main passes validated %s to the atomic storage write', async (status) => {
    const updateMeetingRecap = vi.fn(async () => ({ ok: true }))
    const settings = { synthetic: true }
    const update = boundary('main', {
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      UpdateRecapPayloadSchema,
      getSettings: () => settings,
      updateMeetingRecap,
      auditLog: vi.fn(),
      enqueueIngest: vi.fn(async () => undefined),
      basename: (file: string) => file,
      join: (...parts: string[]) => parts.join('/'),
      resolveMeetingsFolder: () => '/synthetic-only'
    })
    expect(await update({}, { file: 'synthetic.md', recap: 'Notes', recapStatus: status })).toEqual({ ok: true })
    expect(updateMeetingRecap).toHaveBeenCalledWith(settings, 'synthetic.md', 'Notes', status)
  })

  it('main rejects invalid status before storage, audit or background work', async () => {
    const updateMeetingRecap = vi.fn(),
      auditLog = vi.fn(),
      enqueueIngest = vi.fn()
    const update = boundary('main', {
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      UpdateRecapPayloadSchema,
      updateMeetingRecap,
      auditLog,
      enqueueIngest
    })
    expect((await update({}, { file: 'synthetic.md', recap: 'Notes', recapStatus: 'invented' })).ok).toBe(false)
    expect(updateMeetingRecap).not.toHaveBeenCalled()
    expect(auditLog).not.toHaveBeenCalled()
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  it.each(['import', 'index'] as const)('%s forwards successful generation status to storage', async (kind) => {
    const settings = { synthetic: true }
    const updateMeetingRecap = vi.fn(async () => ({ ok: true }))
    const guard = vi.fn()
    await boundary(kind, { getSettings: () => settings, updateMeetingRecap })(
      'synthetic.md',
      'Notes',
      'complete',
      guard
    )
    if (kind === 'import') {
      expect(updateMeetingRecap).toHaveBeenCalledWith(settings, 'synthetic.md', 'Notes', 'complete', guard)
    } else expect(updateMeetingRecap).toHaveBeenCalledWith(settings, 'synthetic.md', 'Notes', 'complete')
  })

  it('import reports a failed status write as failure to its manager', async () => {
    const update = boundary('import', {
      getSettings: () => ({}),
      updateMeetingRecap: async () => ({ ok: false, error: 'Synthetic write failure' })
    })
    await expect(update('synthetic.md', 'Notes', 'complete')).rejects.toThrow('Synthetic write failure')
  })

  it('rejects disconnected, shadowed or overridden import adapter wiring', () => {
    const source = readFileSync(mainFile, 'utf8')
    const mutations = [
      ['import { createImportMeetingWriteAdapters }', 'import type { createImportMeetingWriteAdapters }'],
      ["from './import-meeting-write-adapters'", "from './unused-import-meeting-write-adapters'"],
      ['importJobs = new ImportJobManager({', 'const unused = new ImportJobManager({'],
      [
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }),',
        'unused: createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }),'
      ],
      [
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }),',
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }), updateRecap: unused,'
      ],
      [
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }),',
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }), updateRecap,'
      ],
      [
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }),',
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }), ...unused,'
      ],
      [
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting, updateMeetingRecap }),',
        '...createImportMeetingWriteAdapters({ getSettings, saveMeeting: unused, updateMeetingRecap }),'
      ],
      [
        'function initializeImportJobs(): void {',
        'function initializeImportJobs(): void { const createImportMeetingWriteAdapters = unused;'
      ]
    ] as const
    for (const [before, after] of mutations) {
      expect(source).toContain(before)
      const changed = source.replace(before, after)
      expect(changed).not.toBe(source)
      expect(() => importAdapterCall(ts.createSourceFile('main', changed, ts.ScriptTarget.Latest, true))).toThrow()
    }
  })
})
