import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import ts from 'typescript'
import { IPC, SaveMeetingSchema, stripProvisionalLines, type SaveDraftTranscriptResult, type SaveMeeting, type Settings } from '@shared/ipc'
import { saveDraftTranscript } from './transcripts'
import { useStorageForTests } from './infra/storage/meetings-storage'
import { startDraftAutosave } from '../renderer/src/lib/draft-autosave'

vi.mock('electron')
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  rename: vi.fn(async (from: string, to: string) => renameSync(from, to))
}))

// Execute the real registered IPC callback, preload method and consumed autosave lifecycle. The App
// delegation is checked by app-recap-lifecycle; this path retains real snapshot IO and failure feedback.
function source(relative: string): ts.SourceFile {
  const path = join(__dirname, relative)
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function findOne(file: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (matches.length !== 1) throw new Error(`Expected one production boundary, found ${matches.length}`)
  return matches[0]!
}

function evaluate<T>(expression: string, context: vm.Context): T {
  vm.runInContext(ts.transpileModule(`globalThis.result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, context, { timeout: 1_000 })
  return context.result as T
}

const main = source('index.ts')
const mainRegistration = findOne(main, node => ts.isCallExpression(node) &&
  node.expression.getText(main) === 'ipcMain.handle' &&
  node.arguments[0]?.getText(main) === 'IPC.saveDraftTranscript') as ts.CallExpression
const preload = source('../preload/index.ts')
const preloadMethod = findOne(preload, node => ts.isPropertyAssignment(node) &&
  node.name.getText(preload) === 'saveDraftTranscript') as ts.PropertyAssignment

describe('draft receipt reaches the actual renderer through main and preload', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    useStorageForTests()
    folder = mkdtempSync(join(tmpdir(), 'asktoto-draft-receipt-'))
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    vi.mocked(rename).mockImplementation(async (from, to) => renameSync(from, to))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(folder, { recursive: true, force: true })
  })

  function host(authenticated = true) {
    const mainContext = vm.createContext({
      SaveMeetingSchema, stripProvisionalLines, saveDraftTranscript,
      assertMainWindow: vi.fn(), requireAuth: () => authenticated, getSettings: () => settings
    })
    const handler = evaluate<(event: unknown, payload: unknown) => Promise<unknown>>(
      mainRegistration.arguments[1]!.getText(main), mainContext)
    const invoke = vi.fn((channel: string, payload: unknown) => {
      expect(channel).toBe(IPC.saveDraftTranscript)
      return handler({}, payload)
    })
    const bridge = evaluate<(payload: SaveMeeting) => Promise<SaveDraftTranscriptResult>>(preloadMethod.initializer.getText(preload),
      vm.createContext({ IPC, ipcRenderer: { invoke } }))
    let tick!: () => void
    let pending: Promise<SaveDraftTranscriptResult> | undefined
    const calls: unknown[] = []
    const save = vi.fn((payload: SaveMeeting) => {
      pending = bridge(payload).then(result => { calls.push(result); return result })
      return pending
    })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
      tick = callback as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const context = vm.createContext({
      listen: { listening: true }, mode: 'meeting',
      meetingStartRef: { current: 1_700_000_000_000 },
      autosaveLinesRef: { current: [
        { speaker: 'them', text: 'Synthetic final speech.', t: 1_700_000_000_000 },
        { speaker: 'them', text: 'Synthetic provisional.', t: 1_700_000_000_001, provisional: true }
      ] },
      autosaveFailsRef: { current: 0 }, setAutosaveWarn: vi.fn(),
      defaultMeetingTitle: () => 'Synthetic meeting'
    })
    const stop = startDraftAutosave({
      mode: 'meeting', getLines: () => context.autosaveLinesRef.current,
      getStartedAt: () => context.meetingStartRef.current, title: context.defaultMeetingTitle,
      failures: context.autosaveFailsRef, warn: context.setAutosaveWarn, save
    })
    const cleanup = () => {
      stop()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
    return {
      context, calls, handler, cleanup,
      async tick() {
        tick()
        await pending
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
  }

  it('reports real write failures, retains warning on policy-disabled receipts and clears on saved', async () => {
    const h = host()
    try {
      vi.mocked(rename).mockRejectedValue(Object.assign(new Error('Synthetic private path'), { code: 'EIO' }))
      await h.tick()
      await h.tick()
      expect(h.calls).toEqual([{ status: 'failed' }, { status: 'failed' }])
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(true)
      settings = { ...settings, enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true } } as Settings
      h.context.setAutosaveWarn.mockClear()
      await h.tick()
      expect(h.calls.at(-1)).toEqual({ status: 'disabled' })
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
      settings = { ...settings, enterpriseLive: { managed: false, inferenceMode: 'legacy', summaryOnly: false } }
      vi.mocked(rename).mockImplementation(async (from, to) => renameSync(from, to))
      await h.tick()
      expect(h.calls.at(-1)).toEqual({ status: 'saved' })
      expect(h.context.autosaveFailsRef.current).toBe(0)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(false)
      const draft = readdirSync(folder).find(file => file.startsWith('.autosave-draft-'))!
      const bytes = readFileSync(join(folder, draft), 'utf8')
      expect(bytes).toContain('Synthetic final speech.')
      expect(bytes).not.toContain('Synthetic provisional.')
    } finally { h.cleanup() }
  })

  it('does not acknowledge unauthenticated or malformed requests as saved', async () => {
    const denied = host(false)
    try { await denied.tick(); expect(denied.calls).toEqual([{ status: 'failed' }]) }
    finally { denied.cleanup() }
    const admitted = host()
    try { await expect(admitted.handler({}, {})).resolves.toEqual({ status: 'failed' }) }
    finally { admitted.cleanup() }
    expect(readdirSync(folder)).toEqual([])
  })
})
