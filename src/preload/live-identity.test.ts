import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(join(__dirname, 'index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
function boundary(
  name: string,
  invoke: (...args: unknown[]) => Promise<unknown>
): (...args: unknown[]) => Promise<unknown> {
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (found.length !== 1) throw new Error(`Missing unique actual preload boundary ${name}`)
  const activationReady = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'meetingStartActivationReady'
  )
  if (!activationReady) throw new Error('Missing actual preload meeting-start activation helper')
  const code = ts.transpileModule(
    `${activationReady.getText(source)}\nglobalThis.result = (${found[0]!.getText(source)});`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }
  ).outputText
  const context = vm.createContext({ ipcRenderer: { invoke }, IPC, observedMeetingStartActivation: null })
  vm.runInContext(code, context, { timeout: 1_000 })
  return context.result
}

describe('actual preload live-identity transport', () => {
  it.each([
    'parakeetFeed',
    'appleSpeechFeed',
    'speakerEmbed'
  ] as const)('%s forwards the exact PCM and optional identity', async (name) => {
    const result = { text: 'Unchanged ASR output', name: 'Speaker 1' }
    const invoke = vi.fn(async (..._args: unknown[]) => result)
    const feed = boundary(name, invoke)
    const samples = Float32Array.from([0.1, -0.2])
    expect(await feed(samples, 'them', 123)).toBe(result)
    expect(invoke).toHaveBeenLastCalledWith(IPC[name], { samples, speaker: 'them', startedAt: 123 })
    expect((invoke.mock.calls[0]![1] as { samples: Float32Array }).samples).toBe(samples)
    await feed(samples, 'you')
    expect(invoke).toHaveBeenLastCalledWith(IPC[name], { samples, speaker: 'you', startedAt: undefined })
  })

  it('sends exact start identity after activation and stops without requiring activation, including legacy stops', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => true)
    const state = boundary('setListeningState', invoke)
    await state(true, 123)
    await state(false, 123)
    await state(false)
    expect(invoke.mock.calls).toEqual([
      [IPC.meetingStartActivationReady],
      [IPC.listeningState, { on: true, startedAt: 123 }],
      [IPC.listeningState, { on: false, startedAt: 123 }],
      [IPC.listeningState, { on: false, startedAt: undefined }]
    ])
  })

  it.each([
    false,
    undefined,
    'true'
  ])('does not dispatch a start when main activation readiness is %s', async (ready) => {
    const invoke = vi.fn(async (..._args: unknown[]) => ready)
    expect(await boundary('setListeningState', invoke)(true, 123)).toBe(false)
    expect(invoke.mock.calls).toEqual([[IPC.meetingStartActivationReady]])
  })

  it('does not dispatch a start when the activation readiness IPC rejects', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => {
      throw new Error('unavailable')
    })
    expect(await boundary('setListeningState', invoke)(true, 123)).toBe(false)
    expect(invoke.mock.calls).toEqual([[IPC.meetingStartActivationReady]])
  })
})
