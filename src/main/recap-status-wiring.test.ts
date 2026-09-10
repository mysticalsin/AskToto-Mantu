import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { UpdateRecapPayloadSchema } from '@shared/ipc'

// Execute the real small IPC/preload boundaries without booting Electron or loading user data.
function boundary(kind: 'main' | 'preload' | 'import' | 'index', globals: Record<string, unknown>): (...args: any[]) => any {
  const file = kind === 'preload' ? join(__dirname, '../preload/index.ts') : join(__dirname, 'index.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
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
    if (kind === 'main' && ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' &&
      node.arguments[0]?.getText(source) === 'IPC.recallUpdateRecap') callback = node.arguments[1]
    if (kind === 'preload' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'recallUpdateRecap') {
      callback = node.initializer
    }
    if (kind === 'import' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'updateRecap' &&
      inFunction(node, 'initializeImportJobs')) callback = node.initializer
    if (kind === 'index' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'save' &&
      inFunction(node, 'wireIntelligenceIndexWork')) callback = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error(`Actual ${kind} recap update boundary not found`)
  const code = ts.transpileModule(`globalThis.result = (${callback.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext(globals)
  vm.runInContext(code, context, { timeout: 1_000 })
  return context.result
}

describe('recap status IPC propagation', () => {
  it.each(['complete', 'incomplete'] as const)('preload forwards explicit %s without adding error content', async (status) => {
    const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true }))
    const update = boundary('preload', { ipcRenderer: { invoke }, IPC: { recallUpdateRecap: 'update' } })
    await update('synthetic.md', 'Notes', status)
    expect(invoke).toHaveBeenCalledWith('update', { file: 'synthetic.md', recap: 'Notes', recapStatus: status })
  })

  it('a legacy manual edit does not invent a completed status', async () => {
    const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true }))
    await boundary('preload', { ipcRenderer: { invoke }, IPC: { recallUpdateRecap: 'update' } })('synthetic.md', 'Notes')
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ file: 'synthetic.md', recap: 'Notes' })
    expect((invoke.mock.calls[0]?.[1] as { recapStatus?: string }).recapStatus).toBeUndefined()
  })

  it.each(['complete', 'incomplete'] as const)('main passes validated %s to the atomic storage write', async (status) => {
    const updateMeetingRecap = vi.fn(async () => ({ ok: true }))
    const settings = { synthetic: true }
    const update = boundary('main', {
      assertMainWindow: vi.fn(), requireAuth: () => true, UpdateRecapPayloadSchema,
      getSettings: () => settings, updateMeetingRecap, auditLog: vi.fn(),
      enqueueIngest: vi.fn(async () => undefined), basename: (file: string) => file,
      join: (...parts: string[]) => parts.join('/'), resolveMeetingsFolder: () => '/synthetic-only'
    })
    expect(await update({}, { file: 'synthetic.md', recap: 'Notes', recapStatus: status })).toEqual({ ok: true })
    expect(updateMeetingRecap).toHaveBeenCalledWith(settings, 'synthetic.md', 'Notes', status)
  })

  it('main rejects invalid status before storage, audit or background work', async () => {
    const updateMeetingRecap = vi.fn(), auditLog = vi.fn(), enqueueIngest = vi.fn()
    const update = boundary('main', {
      assertMainWindow: vi.fn(), requireAuth: () => true, UpdateRecapPayloadSchema,
      updateMeetingRecap, auditLog, enqueueIngest
    })
    expect((await update({}, { file: 'synthetic.md', recap: 'Notes', recapStatus: 'invented' })).ok).toBe(false)
    expect(updateMeetingRecap).not.toHaveBeenCalled()
    expect(auditLog).not.toHaveBeenCalled()
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  it.each(['import', 'index'] as const)('%s forwards successful generation status to storage', async (kind) => {
    const settings = { synthetic: true }
    const updateMeetingRecap = vi.fn(async () => ({ ok: true }))
    await boundary(kind, { getSettings: () => settings, updateMeetingRecap })('synthetic.md', 'Notes', 'complete')
    expect(updateMeetingRecap).toHaveBeenCalledWith(settings, 'synthetic.md', 'Notes', 'complete')
  })

  it('import reports a failed status write as failure to its manager', async () => {
    const update = boundary('import', {
      getSettings: () => ({}), updateMeetingRecap: async () => ({ ok: false, error: 'Synthetic write failure' })
    })
    await expect(update('synthetic.md', 'Notes', 'complete')).rejects.toThrow('Synthetic write failure')
  })
})
