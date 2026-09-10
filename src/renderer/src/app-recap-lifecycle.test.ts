import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { AnswerState } from './state'
import type { SaveMeeting, TranscriptLine } from '@shared/ipc'
import { recapPersistAction } from './lib/transcript'
import {
  OwnedOperationGate, RecapWriteCoordinator, beginOwnedMeetingExit,
  persistRecapOnExit, recapFileIdentity, retireRecapWriteKeys
} from './lib/recap-write-coordinator'

// Execute the application's actual boundary callbacks without importing App (which boots many hooks).
// Only React refs/setters and IPC storage are supplied by the host; ordering/ownership logic is real.
const app = ts.createSourceFile('App.tsx', readFileSync(join(__dirname, 'App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const review = ts.createSourceFile('Review.tsx', readFileSync(join(__dirname, 'components/Review.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function uniqueNode(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (found.length !== 1) throw new Error(`Expected one actual callback boundary, found ${found.length}`)
  return found[0]!
}

function namedExpression(source: ts.SourceFile, name: string): string {
  const node = uniqueNode(source, node =>
    (ts.isVariableDeclaration(node) && node.name.getText(source) === name) ||
    (ts.isFunctionDeclaration(node) && node.name?.text === name))
  if (ts.isFunctionDeclaration(node)) return node.getText(source).replace(/^export\s+/, '')
  if (!ts.isVariableDeclaration(node) || !node.initializer) throw new Error(`Missing ${name} initializer`)
  const initializer = node.initializer
  return (ts.isCallExpression(initializer) && initializer.expression.getText(source) === 'useCallback'
    ? initializer.arguments[0]!
    : initializer).getText(source)
}

function evaluate<T>(expression: string, context: vm.Context): T {
  const code = ts.transpileModule(`globalThis.result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  vm.runInContext(code, context, { timeout: 1_000 })
  return context.result as T
}

function callback<T>(name: string, context: vm.Context, source = app): T {
  return evaluate<T>(namedExpression(source, name), context)
}

function reviewProp<T>(name: string, context: vm.Context): T {
  const prop = uniqueNode(app, node => ts.isJsxAttribute(node) && node.name.getText(app) === name &&
    ts.isJsxAttributes(node.parent) &&
    (ts.isJsxSelfClosingElement(node.parent.parent) || ts.isJsxOpeningElement(node.parent.parent)) &&
    node.parent.parent.tagName.getText(app) === 'Review') as ts.JsxAttribute
  if (!prop.initializer || !ts.isJsxExpression(prop.initializer) || !prop.initializer.expression) {
    throw new Error(`Review ${name} is not an executable prop expression`)
  }
  return evaluate<T>(prop.initializer.expression.getText(app), context)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const ref = <T>(current: T) => ({ current })
const lines: TranscriptLine[] = [{ speaker: 'them', text: 'Synthetic meeting A speech.', t: 1 }]
const partial: AnswerState = {
  id: 'run-a', prompt: '', text: 'Current partial notes.', streaming: false,
  error: null, completion: 'incomplete'
}

function lifecycleHost(save: (payload: SaveMeeting) => Promise<{ path: string }>) {
  const events: string[] = []
  const ui = {
    setSavedPath: vi.fn(), setSaveError: vi.fn(), setSaveAttempts: vi.fn(),
    setSaveGaveUp: vi.fn(), setRecapSaveError: vi.fn(), setNewMeetingToast: vi.fn()
  }
  const saveTranscript = vi.fn(save)
  const recallUpdateRecap = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
  const context = vm.createContext({
    Error, Promise, Set, MAX_SAVE_RETRIES: 0, TITLE_BUDGET: 50,
    IPC_INVOKE_WRAPPER: /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    ...ui, mode: 'meeting', savedPath: null,
    ask: { answer: partial, cancel: vi.fn(() => { events.push('cancel'); return partial }) },
    listen: { lines: [...lines] },
    meetingStartRef: ref(100), savedRef: ref(''), cancelledRef: ref(false),
    claimedSavesRef: ref(new Set<string>()), liveRecapWritesRef: ref(new Set<string>()),
    meetingSaveGateRef: ref(new OwnedOperationGate()),
    savingPromiseRef: ref<Promise<string | null> | null>(null),
    recapWriteCoordinatorRef: ref(new RecapWriteCoordinator()),
    liveRecapTargetRef: ref({ ownerId: '100', runId: 'run-a', file: null, priorText: '' }),
    recapPersistAction, beginOwnedMeetingExit, persistRecapOnExit, retireRecapWriteKeys,
    window: { toto: { saveTranscript, recallUpdateRecap } }
  })
  for (const name of ['recapWriteKey', 'defaultMeetingTitle', 'meetingSaveIsRedundant', 'saveFailureReason',
    'saveMeetingNow', 'persistLiveMeetingOnExit', 'persistAndRetireLiveMeeting']) {
    context[name] = callback(name, context)
  }
  const exitPromises: Promise<void>[] = []
  const persist = context.persistAndRetireLiveMeeting as (snapshot: AnswerState | null) => Promise<void>
  context.persistAndRetireLiveMeeting = (snapshot: AnswerState | null) => {
    events.push(`persist:${context.meetingStartRef.current}`)
    const promise = persist(snapshot)
    exitPromises.push(promise)
    return promise
  }
  const startListen = vi.fn((rescue: boolean) => {
    events.push(`start:${String(rescue)}`)
    context.meetingStartRef.current = 200
    context.liveRecapTargetRef.current = null
    context.savingPromiseRef.current = null
    context.savedRef.current = ''
    context.listen.lines = [{ speaker: 'you', text: 'Synthetic meeting B speech.', t: 2 }]
  })
  context.startListen = startListen
  return {
    context, events, ui, saveTranscript, recallUpdateRecap, startListen, exitPromises,
    manualSave: callback<() => Promise<void>>('manualSave', context),
    newMeeting: callback<() => void>('newMeeting', context)
  }
}

describe('actual App live recap lifecycle', () => {
  it('New meeting snapshots and starts persistence before start(false) advances the owner', async () => {
    const h = lifecycleHost(async () => ({ path: 'a.md' }))
    h.newMeeting()
    expect(h.events).toEqual(['cancel', 'persist:100', 'start:false'])
    expect(h.startListen).toHaveBeenCalledExactlyOnceWith(false)
    await Promise.all(h.exitPromises)
    expect(h.saveTranscript).toHaveBeenCalledExactlyOnceWith({
      title: 'Synthetic meeting A speech.', mode: 'meeting', startedAt: 100,
      lines, recap: 'Current partial notes.', recapStatus: 'incomplete'
    })
    expect(h.ui.setSavedPath).not.toHaveBeenCalled()
    expect(h.recallUpdateRecap).not.toHaveBeenCalled()
  })

  it('joins an in-flight manual save before exit, without duplicate create or recap update', async () => {
    const storage = deferred<{ path: string }>()
    const h = lifecycleHost(() => storage.promise)
    const manual = h.manualSave()
    const joined = h.context.savingPromiseRef.current as Promise<string | null>
    h.newMeeting()
    expect(h.saveTranscript).toHaveBeenCalledTimes(1)
    expect(h.recallUpdateRecap).not.toHaveBeenCalled()
    storage.resolve({ path: 'a.md' })
    await expect(joined).resolves.toBe('a.md')
    await manual
    await Promise.all(h.exitPromises)
    expect(h.saveTranscript).toHaveBeenCalledTimes(1)
    expect(h.recallUpdateRecap).not.toHaveBeenCalled()
    expect(h.ui.setSavedPath).not.toHaveBeenCalled()
    expect(h.context.savingPromiseRef.current).toBeNull()
  })

  it('after a joined manual-save failure, exit rescues the exact old partial into one new file', async () => {
    const storage = deferred<{ path: string }>()
    let attempt = 0
    const h = lifecycleHost(() => ++attempt === 1 ? storage.promise : Promise.resolve({ path: 'a-rescued.md' }))
    const manual = h.manualSave()
    h.newMeeting()
    storage.reject(new Error('Synthetic save failure'))
    await manual
    await Promise.all(h.exitPromises)
    expect(h.saveTranscript).toHaveBeenCalledTimes(2)
    expect(h.saveTranscript.mock.calls.map(([payload]) => payload)).toEqual([
      { title: 'Synthetic meeting A speech.', mode: 'meeting', startedAt: 100, lines, recap: 'Current partial notes.', recapStatus: 'incomplete' },
      { title: 'Synthetic meeting A speech.', mode: 'meeting', startedAt: 100, lines, recap: 'Current partial notes.', recapStatus: 'incomplete' }
    ])
    expect(h.recallUpdateRecap).not.toHaveBeenCalled()
    expect(h.ui.setSavedPath).not.toHaveBeenCalled()
    expect(h.ui.setSaveError).not.toHaveBeenCalled()
  })

  it('joins an earlier transcript-only manual save then updates that file with the newly cancelled recap', async () => {
    const storage = deferred<{ path: string }>()
    const h = lifecycleHost(() => storage.promise)
    h.context.ask.answer = null
    const manual = h.manualSave()
    h.newMeeting()
    storage.resolve({ path: '/synthetic/meetings/a.md' })
    await manual
    await Promise.all(h.exitPromises)
    expect(h.saveTranscript).toHaveBeenCalledExactlyOnceWith({
      title: 'Synthetic meeting A speech.', mode: 'meeting', startedAt: 100, lines, recap: ''
    })
    expect(h.recallUpdateRecap).toHaveBeenCalledExactlyOnceWith(
      '/synthetic/meetings/a.md', 'Current partial notes.', 'incomplete'
    )
    expect(h.ui.setSavedPath).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('a stale A %s cannot paint or unlock the active B manual save', async outcome => {
    const a = deferred<{ path: string }>(), b = deferred<{ path: string }>()
    const h = lifecycleHost(payload => payload.startedAt === 100 ? a.promise : b.promise)
    const first = h.manualSave()
    h.context.meetingStartRef.current = 200
    h.context.ask.answer = { ...partial, id: 'run-b', text: 'Meeting B notes.' }
    h.context.liveRecapTargetRef.current = { ownerId: '200', runId: 'run-b', file: null, priorText: '' }
    const second = h.manualSave()
    const bPath = h.context.savingPromiseRef.current as Promise<string | null>
    if (outcome === 'success') a.resolve({ path: 'a.md' })
    else a.reject(new Error('Synthetic A failure'))
    await first
    expect(h.context.meetingSaveGateRef.current.isActive('200')).toBe(true)
    expect(h.context.savingPromiseRef.current).toBe(bPath)
    for (const setter of Object.values(h.ui)) expect(setter).not.toHaveBeenCalled()
    await h.manualSave()
    expect(h.saveTranscript).toHaveBeenCalledTimes(2)
    b.resolve({ path: 'b.md' })
    await second
    await expect(bPath).resolves.toBe('b.md')
    expect(h.ui.setSavedPath).toHaveBeenCalledExactlyOnceWith('b.md')
    expect(h.context.savedRef.current).toBe('200')
  })

  it.each(['success', 'failure'] as const)('a stale initial autosave A %s cannot paint or unlock B', async outcome => {
    const a = deferred<{ path: string }>(), b = deferred<{ path: string }>()
    const h = lifecycleHost(payload => payload.startedAt === 100 ? a.promise : b.promise)
    Object.assign(h.context, {
      view: 'review', answerId: 'run-a', answerText: 'Meeting A summary.',
      answerStreaming: false, answerError: null, answerCompletion: 'complete', saveAttempts: 0
    })
    const effect = uniqueNode(app, node => ts.isCallExpression(node) &&
      node.expression.getText(app) === 'useEffect' &&
      node.arguments[0]?.getText(app).includes('if (view !== \'review\') return')) as ts.CallExpression
    const autosave = evaluate<() => void>(effect.arguments[0]!.getText(app), h.context)
    autosave()
    const aPath = h.context.savingPromiseRef.current as Promise<string | null>
    h.context.meetingStartRef.current = 200
    h.context.answerId = 'run-b'
    h.context.answerText = 'Meeting B summary.'
    h.context.liveRecapTargetRef.current = { ownerId: '200', runId: 'run-b', file: null, priorText: '' }
    h.context.listen.lines = [{ speaker: 'you', text: 'Synthetic B speech.', t: 2 }]
    autosave()
    const bPath = h.context.savingPromiseRef.current as Promise<string | null>
    if (outcome === 'success') a.resolve({ path: 'a.md' })
    else a.reject(new Error('Synthetic autosave A failure'))
    await expect(aPath).resolves.toBe(outcome === 'success' ? 'a.md' : null)
    expect(h.context.meetingSaveGateRef.current.isActive('200')).toBe(true)
    expect(h.context.savingPromiseRef.current).toBe(bPath)
    for (const setter of Object.values(h.ui)) expect(setter).not.toHaveBeenCalled()
    autosave()
    expect(h.saveTranscript).toHaveBeenCalledTimes(2)
    expect(h.saveTranscript.mock.calls[0]![0]).toMatchObject({
      startedAt: 100, lines, recap: 'Meeting A summary.', recapStatus: 'complete'
    })
    b.resolve({ path: 'b.md' })
    await expect(bPath).resolves.toBe('b.md')
    expect(h.ui.setSavedPath).toHaveBeenCalledExactlyOnceWith('b.md')
    expect(h.ui.setSaveError).toHaveBeenCalledExactlyOnceWith(null)
    expect(h.context.savedRef.current).toBe('200')
    expect(h.context.meetingSaveGateRef.current.isActive('200')).toBe(false)
  })

  it.each([null, { ...partial, id: 'unrelated-run', text: 'Unrelated answer.' }])(
    'manual Save retains ASR without attributing absent or unowned recap text', async answer => {
      const h = lifecycleHost(async () => ({ path: 'transcript-only.md' }))
      h.context.ask.answer = answer
      await h.manualSave()
      expect(h.saveTranscript).toHaveBeenCalledExactlyOnceWith({
        title: 'Synthetic meeting A speech.', mode: 'meeting', startedAt: 100, lines, recap: ''
      })
      expect(h.ui.setSavedPath).toHaveBeenCalledExactlyOnceWith('transcript-only.md')
    }
  )
})

describe('actual App generated-write to Review manual-edit wiring', () => {
  it.each([
    { lane: 'past', generatedPath: 'a.md' },
    { lane: 'live POSIX', generatedPath: '/synthetic/meetings/a.md' },
    { lane: 'live Windows', generatedPath: 'C:\\synthetic\\meetings\\a.md' }
  ])('orders $lane generation before the reopened Review edit of the same file', async ({ lane, generatedPath }) => {
    const generation = deferred<{ ok: boolean }>()
    const calls: unknown[][] = []
    let storedText = '', target: unknown = { file: 'a.md', ownerId: 'a.md', runId: 'generated-a', priorText: '' }
    let pastMeeting = { file: 'a.md', recap: '' }
    const context = vm.createContext({
      Error, Promise, recapPersistAction, recapFileIdentity,
      recapWriteCoordinatorRef: ref(new RecapWriteCoordinator()), manualRecapWriteSeqRef: ref(0),
      recapGenTarget: target, recapGenId: 'generated-a', recapGenRunIdRef: ref('generated-a'),
      recapGenStreaming: false, recapGenText: 'Generated notes.', recapGenError: null,
      recapGenCompletion: 'complete', recapPersistingRef: ref(''),
      setRecapGenTarget: vi.fn((value: unknown) => { target = typeof value === 'function' ? value(target) : value }),
      setPastMeeting: vi.fn((update: (value: typeof pastMeeting) => typeof pastMeeting) => { pastMeeting = update(pastMeeting) }),
      setRecapSaveError: vi.fn(),
      // A live generated write starts with the absolute path returned by saveTranscript. Later History
      // reopens the same file under its basename; the actual Review callback must join that write too.
      view: 'review', savedPath: generatedPath, listen: { lines },
      meetingStartRef: ref(100), liveRecapWritesRef: ref(new Set<string>()),
      liveRecapTargetRef: ref({ ownerId: '100', runId: 'generated-a', file: null, priorText: '' }),
      answerId: 'generated-a', answerStreaming: false, answerText: 'Generated notes.',
      answerError: null, answerCompletion: 'complete',
      window: { toto: { recallUpdateRecap: async (...args: unknown[]) => {
        calls.push(args)
        if (args.length === 3) {
          const result = await generation.promise
          storedText = String(args[1])
          return result
        }
        storedText = String(args[1])
        return { ok: true }
      } } }
    })
    context.recapWriteKey = callback('recapWriteKey', context)
    const effect = uniqueNode(app, node => ts.isCallExpression(node) &&
      node.expression.getText(app) === 'useEffect' &&
      node.arguments[0]?.getText(app).includes(lane === 'past'
        ? 'const owningId = recapGenId'
        : 'if (view !== \'review\') return')) as ts.CallExpression
    const generated = evaluate<() => void>(effect.arguments[0]!.getText(app), context)
    context.updateRecapManually = callback('updateRecapManually', context)
    const onUpdateRecap = reviewProp<(file: string, text: string) => Promise<{ ok: boolean }>>('onUpdateRecap', context)
    const editor = vm.createContext({
      Error, savedPath: 'a.md', savedPathRef: ref('a.md'), recapSaving: false,
      recapDraft: 'Human annotation.', recap: { text: '' }, onUpdateRecap,
      setRecapSaving: vi.fn(), setRecapEditError: vi.fn(), setEditedRecap: vi.fn(),
      setEditingRecap: vi.fn(), onRecapSaved: vi.fn(),
      window: { toto: { recallUpdateRecap: vi.fn(() => { throw new Error('Bypassed the App ordering boundary') }) } }
    })
    generated()
    await Promise.resolve()
    const manual = callback<() => Promise<void>>('saveRecap', editor, review)()
    // Let an incorrectly independent manual queue start before unlocking the old generated write.
    await Promise.resolve()
    const beforeGenerationFinishes = calls.map(args => [...args])
    generation.resolve({ ok: true })
    await manual
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(beforeGenerationFinishes).toEqual([[generatedPath, 'Generated notes.', 'complete']])
    expect(calls).toEqual([
      [generatedPath, 'Generated notes.', 'complete'], ['a.md', 'Human annotation.']
    ])
    expect(storedText).toBe('Human annotation.')
    expect(editor.onRecapSaved).toHaveBeenCalledExactlyOnceWith('Human annotation.')
    expect(context.setPastMeeting).not.toHaveBeenCalled()
    expect(editor.window.toto.recallUpdateRecap).not.toHaveBeenCalled()
    expect(target).toBeNull()
  })
})
