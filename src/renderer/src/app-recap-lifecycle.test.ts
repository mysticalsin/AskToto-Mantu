import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { AnswerState } from './state'
import type { SaveDraftTranscriptResult, SaveMeeting, TranscriptLine } from '@shared/ipc'
import { recapPersistAction } from './lib/transcript'
import { startDraftAutosave } from './lib/draft-autosave'
import { errorWithSavedNote, saveRevokedMeeting } from './lib/revoked-meeting-save'
import {
  OwnedOperationGate,
  RecapWriteCoordinator,
  beginOwnedMeetingExit,
  persistRecapOnExit,
  recapFileIdentity,
  retireRecapWriteKeys
} from './lib/recap-write-coordinator'

// Execute the application's actual boundary callbacks without importing App (which boots many hooks).
// Only React refs/setters and IPC storage are supplied by the host; ordering/ownership logic is real.
const app = ts.createSourceFile(
  'App.tsx',
  readFileSync(join(__dirname, 'App.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const review = ts.createSourceFile(
  'Review.tsx',
  readFileSync(join(__dirname, 'components/Review.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

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
  const node = uniqueNode(
    source,
    (node) =>
      (ts.isVariableDeclaration(node) && node.name.getText(source) === name) ||
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
  )
  if (ts.isFunctionDeclaration(node)) return node.getText(source).replace(/^export\s+/, '')
  if (!ts.isVariableDeclaration(node) || !node.initializer) throw new Error(`Missing ${name} initializer`)
  const initializer = node.initializer
  return (
    ts.isCallExpression(initializer) && initializer.expression.getText(source) === 'useCallback'
      ? initializer.arguments[0]!
      : initializer
  ).getText(source)
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
  const prop = uniqueNode(
    app,
    (node) =>
      ts.isJsxAttribute(node) &&
      node.name.getText(app) === name &&
      ts.isJsxAttributes(node.parent) &&
      (ts.isJsxSelfClosingElement(node.parent.parent) || ts.isJsxOpeningElement(node.parent.parent)) &&
      node.parent.parent.tagName.getText(app) === 'Review'
  ) as ts.JsxAttribute
  if (!prop.initializer || !ts.isJsxExpression(prop.initializer) || !prop.initializer.expression) {
    throw new Error(`Review ${name} is not an executable prop expression`)
  }
  return evaluate<T>(prop.initializer.expression.getText(app), context)
}

function reviewJsxHandler(
  tagName: string,
  attributeName: string,
  options: { ariaLabel?: string; calls?: string } = {}
): string {
  const attribute = uniqueNode(review, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText(review) !== attributeName) return false
    const attributes = node.parent
    if (!ts.isJsxAttributes(attributes)) return false
    const owner = attributes.parent
    if (
      (!ts.isJsxOpeningElement(owner) && !ts.isJsxSelfClosingElement(owner)) ||
      owner.tagName.getText(review) !== tagName
    )
      return false
    if (options.ariaLabel) {
      const label = owner.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(review) === 'aria-label'
      )
      if (!label?.initializer || !ts.isStringLiteral(label.initializer) || label.initializer.text !== options.ariaLabel)
        return false
    }
    if (options.calls) {
      let foundCall = false
      const visit = (candidate: ts.Node): void => {
        if (
          ts.isCallExpression(candidate) &&
          ((ts.isIdentifier(candidate.expression) && candidate.expression.text === options.calls) ||
            (ts.isPropertyAccessExpression(candidate.expression) && candidate.expression.name.text === options.calls))
        )
          foundCall = true
        ts.forEachChild(candidate, visit)
      }
      visit(node)
      if (!foundCall) return false
    }
    return true
  }) as ts.JsxAttribute
  if (!attribute.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
    throw new Error(`Review ${tagName}.${attributeName} is not an executable callback`)
  }
  return attribute.initializer.expression.getText(review)
}

function optionalReviewExpression(name: string): string | null {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) && node.name.getText(review) === name) ||
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
    )
      found = true
    ts.forEachChild(node, visit)
  }
  visit(review)
  return found ? namedExpression(review, name) : null
}

function reviewEffectExpression(predicate: (callback: ts.ArrowFunction) => boolean): string {
  const effect = uniqueNode(
    review,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(review) === 'useEffect' &&
      node.arguments[0] !== undefined &&
      ts.isArrowFunction(node.arguments[0]) &&
      predicate(node.arguments[0])
  ) as ts.CallExpression
  return effect.arguments[0]!.getText(review)
}

function reviewUseRef(name: string, renderValues: Record<string, unknown>): { current: unknown } | undefined {
  const initializer = optionalReviewExpression(name)
  if (!initializer) return undefined
  return evaluate<{ current: unknown }>(
    initializer,
    vm.createContext({ ...renderValues, useRef: (current: unknown) => ref(current) })
  )
}

function reviewEditCallbacks(renderValues: Record<string, unknown>) {
  const bindings = Object.keys(renderValues).join(', ')
  const optionalDraftHandler = optionalReviewExpression('handleRecapDraftChange') ?? 'undefined'
  const savedPathRefEffect = reviewEffectExpression((callback) => {
    let matches = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.getText(review) === 'savedPathRef' &&
        node.left.name.text === 'current' &&
        node.right.getText(review) === 'savedPath'
      )
        matches = true
      ts.forEachChild(node, visit)
    }
    visit(callback)
    return matches
  })
  const savedPathResetEffect = reviewEffectExpression((callback) => {
    const calls = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(callback)
    return calls.has('setEditingRecap') && calls.has('setEditedRecap') && calls.has('setRecapEditError')
  })
  const context = vm.createContext({ render: renderValues, Error, Promise })
  return evaluate<{
    recapDirty: boolean
    recapDraft: string
    startEditRecap: () => void
    cancelEditRecap: () => void
    requestCancelEditRecap: () => Promise<void>
    saveRecap: () => Promise<boolean>
    guardRecapEditNavigation: () => Promise<boolean>
    draftOnChange: (event: { target: { value: string } }) => void
    draftOnKeyDown: (event: Record<string, unknown>) => void
    doneOnClick: () => void
    resumeOnClick: () => void
    recentOnClick: () => void
    savedPathRefEffect: () => void
    savedPathResetEffect: () => void
  }>(
    `(() => {
      const { ${bindings} } = render;
      const recapDirty = ${namedExpression(review, 'recapDirty')};
      const startEditRecap = ${namedExpression(review, 'startEditRecap')};
      const cancelEditRecap = ${namedExpression(review, 'cancelEditRecap')};
      const recapEditSnapshot = ${namedExpression(review, 'recapEditSnapshot')};
      const saveRecap = ${namedExpression(review, 'saveRecap')};
      const guardRecapEditNavigation = ${namedExpression(review, 'guardRecapEditNavigation')};
      const requestCancelEditRecap = ${namedExpression(review, 'requestCancelEditRecap')};
      const handleRecapDraftChange = ${optionalDraftHandler};
      return {
        recapDirty,
        recapDraft,
        startEditRecap,
        cancelEditRecap,
        requestCancelEditRecap,
        saveRecap,
        guardRecapEditNavigation,
        draftOnChange: ${reviewJsxHandler('textarea', 'onChange', { ariaLabel: 'Edit meeting notes' })},
        draftOnKeyDown: ${reviewJsxHandler('textarea', 'onKeyDown', { ariaLabel: 'Edit meeting notes' })},
        doneOnClick: ${reviewJsxHandler('Chip', 'onClick', { calls: 'onDone' })},
        resumeOnClick: ${reviewJsxHandler('Chip', 'onClick', { calls: 'onResume' })},
        recentOnClick: ${reviewJsxHandler('button', 'onClick', { calls: 'onOpenPastMeeting' })},
        savedPathRefEffect: ${savedPathRefEffect},
        savedPathResetEffect: ${savedPathResetEffect}
      };
    })()`,
    context
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type DiscardSavedTranscript = (
  startedAt: number,
  title: string,
  path?: string
) => Promise<{ ok: boolean; error?: string; deletedPaths?: string[] }>
type DiscardDraftTranscript = (startedAt: number) => Promise<{ ok: boolean; error?: string }>

const ref = <T>(current: T) => ({ current })
const lines: TranscriptLine[] = [{ speaker: 'them', text: 'Synthetic meeting A speech.', t: 1 }]
const partial: AnswerState = {
  id: 'run-a',
  prompt: '',
  text: 'Current partial notes.',
  streaming: false,
  error: null,
  completion: 'incomplete'
}

function lifecycleHost(save: (payload: SaveMeeting) => Promise<{ path: string }>) {
  const events: string[] = []
  const ui = {
    setSavedPath: vi.fn(),
    setSaveError: vi.fn(),
    setSaveAttempts: vi.fn(),
    setSaveGaveUp: vi.fn(),
    setRecapSaveError: vi.fn(),
    setNewMeetingToast: vi.fn()
  }
  const saveTranscript = vi.fn(save)
  const recallUpdateRecap = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
  const preserveDraftTranscript = vi.fn(async (_startedAt: number) => ({ ok: true }))
  const discardSavedTranscript = vi.fn<DiscardSavedTranscript>(async (startedAt, _title, path) => ({
    ok: true,
    deletedPaths: path ? [path] : []
  }))
  const discardDraftTranscript = vi.fn<DiscardDraftTranscript>(async (_startedAt) => ({ ok: true }))
  const setDiscardPendingOwner = vi.fn()
  const reset = vi.fn()
  const retryCallbacks: Array<() => void> = []
  const retryIds: number[] = []
  const clearedRetryIds: number[] = []
  let nextRetryId = 0
  const setTimeoutSpy = vi.fn((callback: () => void, _delay: number) => {
    const id = ++nextRetryId
    retryIds.push(id)
    retryCallbacks.push(callback)
    return id as unknown as ReturnType<typeof setTimeout>
  })
  const clearTimeoutSpy = vi.fn((timer: ReturnType<typeof setTimeout>) => {
    clearedRetryIds.push(timer as unknown as number)
  })
  const context = vm.createContext({
    Error,
    Promise,
    Set,
    MAX_SAVE_RETRIES: 0,
    TITLE_BUDGET: 50,
    IPC_INVOKE_WRAPPER: /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    ...ui,
    mode: 'meeting',
    savedPath: null,
    saveAttempts: 0,
    ask: {
      answer: partial,
      cancel: vi.fn(() => {
        events.push('cancel')
        return partial
      })
    },
    listen: { lines: [...lines] },
    meetingStartRef: ref(100),
    savedRef: ref(''),
    discardPendingOwnerRef: ref<string | null>(null),
    discardedMeetingRef: ref<string | null>(null),
    deletedTranscriptForDiscardRef: ref<{ ownerId: string; paths: string[] } | null>(null),
    saveRetryTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    cancelledRef: ref(false),
    claimedSavesRef: ref(new Set<string>()),
    liveRecapWritesRef: ref(new Set<string>()),
    meetingSaveGateRef: ref(new OwnedOperationGate()),
    savingPromiseRef: ref<Promise<string | null> | null>(null),
    recapWriteCoordinatorRef: ref(new RecapWriteCoordinator()),
    liveRecapTargetRef: ref({ ownerId: '100', runId: 'run-a', file: null, priorText: '' }),
    recapPersistAction,
    beginOwnedMeetingExit,
    persistRecapOnExit,
    retireRecapWriteKeys,
    setDiscardPendingOwner,
    reset,
    setTimeout: setTimeoutSpy,
    clearTimeout: clearTimeoutSpy,
    window: {
      toto: {
        saveTranscript,
        recallUpdateRecap,
        preserveDraftTranscript,
        discardSavedTranscript,
        discardDraftTranscript
      }
    }
  })
  for (const name of [
    'recapWriteKey',
    'defaultMeetingTitle',
    'meetingSaveIsRedundant',
    'saveFailureReason',
    'saveMeetingNow',
    'saveLiveMeetingNow',
    'persistLiveMeetingOnExit',
    'persistAndRetireLiveMeeting'
  ]) {
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
    context,
    events,
    ui,
    saveTranscript,
    recallUpdateRecap,
    preserveDraftTranscript,
    discardSavedTranscript,
    discardDraftTranscript,
    setDiscardPendingOwner,
    reset,
    retryCallbacks,
    retryIds,
    clearedRetryIds,
    setTimeout: setTimeoutSpy,
    clearTimeout: clearTimeoutSpy,
    startListen,
    exitPromises,
    manualSave: callback<() => Promise<void>>('manualSave', context),
    newMeeting: callback<() => void>('newMeeting', context),
    saveLiveMeetingNow: callback<
      (lines: TranscriptLine[], started: number, recapText: string) => Promise<string | null>
    >('saveLiveMeetingNow', context),
    persistLiveMeetingOnExit: callback<(snapshot: AnswerState | null, maxAttempts?: number) => Promise<void>>(
      'persistLiveMeetingOnExit',
      context
    ),
    discardMeeting: callback<() => Promise<void>>('discardMeeting', context),
    autosave() {
      const effect = uniqueNode(
        app,
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(app) === 'useEffect' &&
          node.arguments[0]?.getText(app).includes("if (view !== 'review') return")
      ) as ts.CallExpression
      const run = evaluate<() => void>(effect.arguments[0]!.getText(app), context)
      return run()
    }
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
      title: 'Synthetic meeting A speech.',
      mode: 'meeting',
      startedAt: 100,
      lines,
      recap: 'Current partial notes.',
      recapStatus: 'incomplete'
    })
    expect(h.ui.setSavedPath).not.toHaveBeenCalled()
    expect(h.recallUpdateRecap).not.toHaveBeenCalled()
  })

  it('a forced revoke with lines saves once; a later reset does not save again', async () => {
    const h = lifecycleHost(async () => ({ path: 'a.md' }))
    const handled = { current: null as string | null }
    const ownership = {
      meetingStartRef: h.context.meetingStartRef,
      discardedMeetingRef: h.context.discardedMeetingRef,
      discardPendingOwnerRef: h.context.discardPendingOwnerRef,
      claimedSavesRef: h.context.claimedSavesRef,
      savedRef: h.context.savedRef
    }
    const ended = { reason: 'screen-locked', startedAt: 100 }
    const run = (override: Partial<Parameters<typeof saveRevokedMeeting>[0]> = {}) =>
      saveRevokedMeeting({
        ended,
        lineCount: lines.length,
        handled,
        ownership,
        persist: () => h.context.persistAndRetireLiveMeeting(h.context.ask.cancel()),
        ...override
      })

    // The banner may claim "saved" only once this resolves.
    await expect(run()).resolves.toBe('100')
    expect(h.saveTranscript).toHaveBeenCalledTimes(1)
    expect(errorWithSavedNote('Listening stopped when your Mac locked.', ended, '100')).toBe(
      'Listening stopped when your Mac locked. Your transcript is saved.'
    )

    // The same end observed again (re-render, effect re-run) is a no-op.
    await expect(run()).resolves.toBeNull()
    expect(h.saveTranscript).toHaveBeenCalledTimes(1)

    // A later New meeting / reset rescue of the same owner finds it claimed and writes nothing more.
    h.newMeeting()
    await Promise.all(h.exitPromises)
    expect(h.saveTranscript).toHaveBeenCalledTimes(1)
  })

  it('never saves for a sign-in that ended, an empty transcript, a discarded owner or a successor meeting', async () => {
    const h = lifecycleHost(async () => ({ path: 'a.md' }))
    const base = {
      lineCount: lines.length,
      handled: { current: null as string | null },
      ownership: {
        meetingStartRef: h.context.meetingStartRef,
        discardedMeetingRef: h.context.discardedMeetingRef,
        discardPendingOwnerRef: h.context.discardPendingOwnerRef,
        claimedSavesRef: h.context.claimedSavesRef,
        savedRef: h.context.savedRef
      },
      persist: () => h.context.persistAndRetireLiveMeeting(h.context.ask.cancel())
    }
    for (const reason of ['sign-out', 'auth-revoked'])
      await expect(saveRevokedMeeting({ ...base, ended: { reason, startedAt: 100 } })).resolves.toBeNull()
    await expect(
      saveRevokedMeeting({ ...base, lineCount: 0, ended: { reason: 'screen-locked', startedAt: 100 } })
    ).resolves.toBeNull()
    await expect(saveRevokedMeeting({ ...base, ended: { reason: 'screen-locked', startedAt: 99 } })).resolves.toBeNull()
    h.context.discardedMeetingRef.current = '100'
    await expect(
      saveRevokedMeeting({ ...base, ended: { reason: 'system-suspend', startedAt: 100 } })
    ).resolves.toBeNull()
    expect(h.saveTranscript).not.toHaveBeenCalled()
  })

  it('reports no saved note when the revoke-time save gives up', async () => {
    const h = lifecycleHost(async () => {
      throw new Error('disk full')
    })
    const saved = await saveRevokedMeeting({
      ended: { reason: 'system-suspend', startedAt: 100 },
      lineCount: lines.length,
      handled: { current: null },
      ownership: {
        meetingStartRef: h.context.meetingStartRef,
        discardedMeetingRef: h.context.discardedMeetingRef,
        discardPendingOwnerRef: h.context.discardPendingOwnerRef,
        claimedSavesRef: h.context.claimedSavesRef,
        savedRef: h.context.savedRef
      },
      persist: () => h.context.persistAndRetireLiveMeeting(h.context.ask.cancel())
    })
    expect(saved).toBeNull()
    expect(errorWithSavedNote('Listening stopped.', { reason: 'system-suspend', startedAt: 100 }, saved)).toBe(
      'Listening stopped.'
    )
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
    const h = lifecycleHost(() => (++attempt === 1 ? storage.promise : Promise.resolve({ path: 'a-rescued.md' })))
    const manual = h.manualSave()
    h.newMeeting()
    storage.reject(new Error('Synthetic save failure'))
    await manual
    await Promise.all(h.exitPromises)
    expect(h.saveTranscript).toHaveBeenCalledTimes(2)
    expect(h.saveTranscript.mock.calls.map(([payload]) => payload)).toEqual([
      {
        title: 'Synthetic meeting A speech.',
        mode: 'meeting',
        startedAt: 100,
        lines,
        recap: 'Current partial notes.',
        recapStatus: 'incomplete'
      },
      {
        title: 'Synthetic meeting A speech.',
        mode: 'meeting',
        startedAt: 100,
        lines,
        recap: 'Current partial notes.',
        recapStatus: 'incomplete'
      }
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
      title: 'Synthetic meeting A speech.',
      mode: 'meeting',
      startedAt: 100,
      lines,
      recap: ''
    })
    expect(h.recallUpdateRecap).toHaveBeenCalledExactlyOnceWith(
      '/synthetic/meetings/a.md',
      'Current partial notes.',
      'incomplete'
    )
    expect(h.ui.setSavedPath).not.toHaveBeenCalled()
  })

  it.each([
    'success',
    'failure'
  ] as const)('a stale A %s cannot paint or unlock the active B manual save', async (outcome) => {
    const a = deferred<{ path: string }>(),
      b = deferred<{ path: string }>()
    const h = lifecycleHost((payload) => (payload.startedAt === 100 ? a.promise : b.promise))
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

  it.each([
    'success',
    'failure'
  ] as const)('a stale initial autosave A %s cannot paint or unlock B', async (outcome) => {
    const a = deferred<{ path: string }>(),
      b = deferred<{ path: string }>()
    const h = lifecycleHost((payload) => (payload.startedAt === 100 ? a.promise : b.promise))
    Object.assign(h.context, {
      view: 'review',
      answerId: 'run-a',
      answerText: 'Meeting A summary.',
      answerStreaming: false,
      answerError: null,
      answerCompletion: 'complete',
      saveAttempts: 0
    })
    const effect = uniqueNode(
      app,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(app) === 'useEffect' &&
        node.arguments[0]?.getText(app).includes("if (view !== 'review') return")
    ) as ts.CallExpression
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
      startedAt: 100,
      lines,
      recap: 'Meeting A summary.',
      recapStatus: 'complete'
    })
    b.resolve({ path: 'b.md' })
    await expect(bPath).resolves.toBe('b.md')
    expect(h.ui.setSavedPath).toHaveBeenCalledExactlyOnceWith('b.md')
    expect(h.ui.setSaveError).toHaveBeenCalledExactlyOnceWith(null)
    expect(h.context.savedRef.current).toBe('200')
    expect(h.context.meetingSaveGateRef.current.isActive('200')).toBe(false)
  })

  it.each([
    null,
    { ...partial, id: 'unrelated-run', text: 'Unrelated answer.' }
  ])('manual Save retains ASR without attributing absent or unowned recap text', async (answer) => {
    const h = lifecycleHost(async () => ({ path: 'transcript-only.md' }))
    h.context.ask.answer = answer
    await h.manualSave()
    expect(h.saveTranscript).toHaveBeenCalledExactlyOnceWith({
      title: 'Synthetic meeting A speech.',
      mode: 'meeting',
      startedAt: 100,
      lines,
      recap: ''
    })
    expect(h.ui.setSavedPath).toHaveBeenCalledExactlyOnceWith('transcript-only.md')
  })

  it('holds the pending and completed discard fence to A while owner B remains saveable', async () => {
    const joinedSave = deferred<string | null>()
    const h = lifecycleHost(async () => ({ path: 'b.md' }))
    try {
      h.context.view = 'review'
      h.context.answerId = 'run-a'
      h.context.answerText = 'Meeting A summary.'
      h.context.answerStreaming = false
      h.context.answerError = null
      h.context.answerCompletion = 'complete'
      h.context.saveAttempts = 1
      h.context.savingPromiseRef.current = joinedSave.promise

      h.autosave()
      expect(h.retryCallbacks).toHaveLength(1)
      const retainedRetry = h.retryCallbacks[0]!
      const discard = h.discardMeeting()
      expect(h.context.discardPendingOwnerRef.current).toBe('100')
      expect(h.clearTimeout).toHaveBeenCalledExactlyOnceWith(1)

      await h.manualSave()
      h.autosave()
      await h.persistLiveMeetingOnExit(partial, 0)
      retainedRetry() // A retry already queued by the event loop still sees the pending owner fence.
      await Promise.resolve()
      expect(h.saveTranscript).not.toHaveBeenCalled()
      expect(h.preserveDraftTranscript).not.toHaveBeenCalled()

      joinedSave.resolve('a.md')
      await discard
      expect(h.discardSavedTranscript).toHaveBeenCalledExactlyOnceWith(100, 'Synthetic meeting A speech.', 'a.md')
      expect(h.discardDraftTranscript).toHaveBeenCalledExactlyOnceWith(100)
      expect(h.context.discardedMeetingRef.current).toBe('100')
      expect(h.context.discardPendingOwnerRef.current).toBeNull()

      await h.manualSave()
      h.autosave()
      await h.persistLiveMeetingOnExit(partial, 0)
      expect(h.saveTranscript).not.toHaveBeenCalled()
      expect(h.preserveDraftTranscript).not.toHaveBeenCalled()

      h.context.meetingStartRef.current = 200
      h.context.ask.answer = { ...partial, id: 'run-b', text: 'Meeting B notes.' }
      h.context.liveRecapTargetRef.current = { ownerId: '200', runId: 'run-b', file: null, priorText: '' }
      h.context.listen.lines = [{ speaker: 'them', text: 'Synthetic meeting B speech.', t: 2 }]
      await h.manualSave()
      expect(h.saveTranscript).toHaveBeenCalledExactlyOnceWith({
        title: 'Synthetic meeting B speech.',
        mode: 'meeting',
        startedAt: 200,
        lines: h.context.listen.lines,
        recap: 'Meeting B notes.',
        recapStatus: 'incomplete'
      })
    } finally {
      joinedSave.resolve(null)
      await Promise.allSettled(h.exitPromises)
    }
  })

  it('preserves the exact owner draft after failed or skipped terminal persistence', async () => {
    const storage = deferred<{ path: string }>()
    const failed = lifecycleHost(() => storage.promise)
    try {
      const exit = failed.persistLiveMeetingOnExit(partial, 0)
      failed.context.meetingStartRef.current = 200
      failed.context.ask.answer = { ...partial, id: 'run-b', text: 'Meeting B notes.' }
      storage.reject(new Error('Synthetic save failure'))
      await exit
      expect(failed.preserveDraftTranscript).toHaveBeenCalledExactlyOnceWith(100)
      expect(failed.ui.setSavedPath).not.toHaveBeenCalled()
    } finally {
      storage.resolve({ path: 'cleanup.md' })
    }

    const skipped = lifecycleHost(async () => ({ path: 'unused.md' }))
    skipped.context.listen.lines = []
    await skipped.persistLiveMeetingOnExit(partial, 0)
    expect(skipped.preserveDraftTranscript).toHaveBeenCalledExactlyOnceWith(100)
    expect(skipped.saveTranscript).not.toHaveBeenCalled()

    const durable = lifecycleHost(async () => ({ path: 'unused.md' }))
    durable.context.savedPath = '/synthetic/meetings/a.md'
    durable.context.savedRef.current = '100'
    durable.context.liveRecapTargetRef.current = null
    await durable.persistLiveMeetingOnExit(null, 0)
    expect(durable.preserveDraftTranscript).not.toHaveBeenCalled()
    expect(durable.saveTranscript).not.toHaveBeenCalled()
  })

  it('keeps the no-provider live save reachable by Disregard and joins it before deleting', async () => {
    const storage = deferred<{ path: string }>()
    const h = lifecycleHost(() => storage.promise)
    try {
      const liveSave = h.saveLiveMeetingNow([...lines], 100, '')
      const discard = h.discardMeeting()
      expect(h.saveTranscript).toHaveBeenCalledExactlyOnceWith({
        title: 'Synthetic meeting A speech.',
        mode: 'meeting',
        startedAt: 100,
        lines,
        recap: ''
      })
      expect(h.discardSavedTranscript).not.toHaveBeenCalled()
      expect(h.discardDraftTranscript).not.toHaveBeenCalled()
      expect(h.reset).not.toHaveBeenCalled()

      storage.resolve({ path: '/synthetic/meetings/a.md' })
      await expect(liveSave).resolves.toBe('/synthetic/meetings/a.md')
      await discard
      expect(h.discardSavedTranscript).toHaveBeenCalledExactlyOnceWith(
        100,
        'Synthetic meeting A speech.',
        '/synthetic/meetings/a.md'
      )
      expect(h.discardDraftTranscript).toHaveBeenCalledExactlyOnceWith(100)
      expect(h.reset).toHaveBeenCalledTimes(1)
      expect(h.context.discardedMeetingRef.current).toBe('100')
    } finally {
      storage.resolve({ path: '/synthetic/meetings/cleanup.md' })
    }
  })

  it.each([
    { result: { ok: false, error: 'cancelled' }, label: 'native cancel' },
    { result: { ok: false, error: 'durable delete failed' }, label: 'durable-delete failure' }
  ] as const)('$label keeps the draft and leaves Disregard retryable', async ({ result }) => {
    const h = lifecycleHost(async () => ({ path: 'unused.md' }))
    h.context.savedPath = '/synthetic/meetings/a.md'
    h.discardSavedTranscript.mockResolvedValueOnce(result)
    await h.discardMeeting()
    expect(h.discardSavedTranscript).toHaveBeenCalledExactlyOnceWith(
      100,
      'Synthetic meeting A speech.',
      '/synthetic/meetings/a.md'
    )
    expect(h.discardDraftTranscript).not.toHaveBeenCalled()
    expect(h.context.discardedMeetingRef.current).toBeNull()
    expect(h.context.discardPendingOwnerRef.current).toBeNull()
    expect(h.reset).not.toHaveBeenCalled()
  })

  it('retries failed draft retirement without repeating confirmed saved-file deletion', async () => {
    const h = lifecycleHost(async () => ({ path: 'unused.md' }))
    const savedPath = '/synthetic/meetings/a.md'
    h.context.savedPath = savedPath
    h.discardDraftTranscript
      .mockResolvedValueOnce({ ok: false, error: 'draft retirement failed' })
      .mockResolvedValueOnce({ ok: true })

    await h.discardMeeting()
    expect(h.discardSavedTranscript).toHaveBeenCalledExactlyOnceWith(100, 'Synthetic meeting A speech.', savedPath)
    expect(h.context.deletedTranscriptForDiscardRef.current).toEqual({ ownerId: '100', paths: [savedPath] })
    expect(h.context.discardedMeetingRef.current).toBeNull()
    expect(h.context.discardPendingOwnerRef.current).toBeNull()
    expect(h.reset).not.toHaveBeenCalled()

    await h.discardMeeting()
    expect(h.discardSavedTranscript).toHaveBeenCalledTimes(2)
    expect(h.discardSavedTranscript.mock.calls[1]).toEqual([100, 'Synthetic meeting A speech.', undefined])
    expect(h.discardDraftTranscript).toHaveBeenCalledTimes(2)
    expect(h.context.discardedMeetingRef.current).toBe('100')
    expect(h.context.discardPendingOwnerRef.current).toBeNull()
    expect(h.reset).toHaveBeenCalledTimes(1)
  })

  it('does not pass B data to A discard when ownership changes during the save join', async () => {
    const storage = deferred<{ path: string }>()
    const h = lifecycleHost(() => storage.promise)
    try {
      h.saveLiveMeetingNow([...lines], 100, '')
      const discard = h.discardMeeting()
      h.context.meetingStartRef.current = 200
      h.context.savedPath = '/synthetic/meetings/b.md'
      storage.resolve({ path: '/synthetic/meetings/a.md' })
      await discard
      expect(h.discardSavedTranscript).not.toHaveBeenCalled()
      expect(h.discardDraftTranscript).not.toHaveBeenCalled()
      expect(h.context.discardedMeetingRef.current).toBeNull()
      expect(h.context.discardPendingOwnerRef.current).toBeNull()
      expect(h.reset).not.toHaveBeenCalled()
    } finally {
      storage.resolve({ path: '/synthetic/meetings/cleanup.md' })
    }
  })

  it.each([
    'resolved cancellation',
    'IPC rejection'
  ] as const)('does not paint A’s late delete %s over successor B', async (failure) => {
    const deletion = deferred<{ ok: boolean; error?: string }>()
    const h = lifecycleHost(async () => ({ path: 'unused.md' }))
    h.context.savedPath = '/synthetic/meetings/a.md'
    h.discardSavedTranscript.mockImplementation(async () => deletion.promise)
    try {
      const discard = h.discardMeeting()
      await Promise.resolve()
      h.context.meetingStartRef.current = 200
      if (failure === 'resolved cancellation') deletion.resolve({ ok: false, error: 'cancelled' })
      else deletion.reject(new Error('Synthetic discard IPC failure'))
      await discard
      expect(h.ui.setSaveError).not.toHaveBeenCalled()
      expect(h.discardDraftTranscript).not.toHaveBeenCalled()
      expect(h.context.discardedMeetingRef.current).toBeNull()
      expect(h.context.discardPendingOwnerRef.current).toBeNull()
      expect(h.reset).not.toHaveBeenCalled()
    } finally {
      deletion.resolve({ ok: false, error: 'cleanup' })
    }
  })

  it('does not paint A’s late draft-retirement failure over successor B', async () => {
    const savedPath = '/synthetic/meetings/a.md'
    const draftRetirement = deferred<{ ok: boolean; error?: string }>()
    const draftStarted = deferred<number>()
    const h = lifecycleHost(async () => ({ path: 'unused.md' }))
    h.context.savedPath = savedPath
    h.discardDraftTranscript.mockImplementation(async (startedAt) => {
      draftStarted.resolve(startedAt)
      return draftRetirement.promise
    })
    try {
      const discard = h.discardMeeting()
      await expect(draftStarted.promise).resolves.toBe(100)
      h.context.meetingStartRef.current = 200
      draftRetirement.resolve({ ok: false, error: 'draft retirement failed' })
      await discard
      expect(h.ui.setSaveError).not.toHaveBeenCalled()
      expect(h.context.deletedTranscriptForDiscardRef.current).toEqual({ ownerId: '100', paths: [savedPath] })
      expect(h.context.discardedMeetingRef.current).toBeNull()
      expect(h.context.discardPendingOwnerRef.current).toBeNull()
      expect(h.reset).not.toHaveBeenCalled()
    } finally {
      draftRetirement.resolve({ ok: false, error: 'cleanup' })
    }
  })

  it('finishes A deletion and draft cleanup without painting or resetting a successor B', async () => {
    const savedPath = '/synthetic/meetings/a.md'
    const savedDelete = deferred<{ ok: boolean; deletedPaths?: string[] }>()
    const draftRetirement = deferred<{ ok: boolean }>()
    const draftStarted = deferred<number>()
    const h = lifecycleHost(async () => ({ path: 'unused.md' }))
    h.context.savedPath = savedPath
    h.discardSavedTranscript.mockImplementation(async () => savedDelete.promise)
    h.discardDraftTranscript.mockImplementation(async (startedAt) => {
      draftStarted.resolve(startedAt)
      return draftRetirement.promise
    })
    try {
      const discard = h.discardMeeting()
      expect(h.discardSavedTranscript).toHaveBeenCalledExactlyOnceWith(100, 'Synthetic meeting A speech.', savedPath)
      h.context.meetingStartRef.current = 200
      h.context.savedPath = '/synthetic/meetings/b.md'
      h.context.savedRef.current = 'b-prior-state'
      savedDelete.resolve({ ok: true, deletedPaths: [savedPath] })
      await expect(draftStarted.promise).resolves.toBe(100)
      expect(h.discardDraftTranscript).toHaveBeenCalledExactlyOnceWith(100)
      draftRetirement.resolve({ ok: true })
      await discard
      expect(h.context.discardedMeetingRef.current).toBe('100')
      expect(h.context.savedRef.current).toBe('b-prior-state')
      expect(h.context.discardPendingOwnerRef.current).toBeNull()
      expect(h.reset).not.toHaveBeenCalled()
      expect(h.ui.setSavedPath).not.toHaveBeenCalled()
    } finally {
      savedDelete.resolve({ ok: false })
      draftRetirement.resolve({ ok: false })
      await Promise.allSettled(h.exitPromises)
    }
  })
})

type ReviewRecapResult = { ok: boolean; error?: string }

function reviewRecapHost() {
  const state: {
    editingRecap: boolean
    recapDraft: string
    recapSaving: boolean
    recapEditError: string | null
    editedRecap: { base: string; text: string } | null
  } = {
    editingRecap: false,
    recapDraft: '',
    recapSaving: false,
    recapEditError: null,
    editedRecap: null
  }
  const writes: Array<{
    file: string
    text: string
    result: ReturnType<typeof deferred<ReviewRecapResult>>
  }> = []
  const updateRecap = vi.fn((file: string, text: string) => {
    const result = deferred<ReviewRecapResult>()
    writes.push({ file, text, result })
    return result.promise
  })
  const setEditingRecap = vi.fn((value: boolean) => {
    state.editingRecap = value
  })
  const setRecapDraft = vi.fn((value: string) => {
    state.recapDraft = value
  })
  const setRecapSaving = vi.fn((value: boolean) => {
    state.recapSaving = value
  })
  const setRecapEditError = vi.fn((value: string | null) => {
    state.recapEditError = value
  })
  const setEditedRecap = vi.fn((value: { base: string; text: string } | null) => {
    state.editedRecap = value
  })
  const savedPathRef = reviewUseRef('savedPathRef', { savedPath: 'a.md' })!
  const recapEditIdentityRef = reviewUseRef('recapEditIdentityRef', { savedPath: 'a.md' })
  const navigationChoice = deferred<'save' | 'discard' | 'cancel'>()
  const navigationGuard = { request: vi.fn(() => navigationChoice.promise) }
  const onDone = vi.fn()
  const onResume = vi.fn()
  const onOpenPastMeeting = vi.fn()
  const onRecapSaved = vi.fn()

  const render = (options: { savedPath?: string; recapText?: string } = {}) => {
    const savedPath = options.savedPath ?? 'a.md'
    const recapText = options.recapText ?? state.editedRecap?.text ?? 'Saved recap.'
    const renderValues = {
      savedPath,
      savedPathRef,
      recapEditIdentityRef,
      editingRecap: state.editingRecap,
      recapDraft: state.recapDraft,
      recapSaving: state.recapSaving,
      recapEditError: state.recapEditError,
      recapText,
      recap: { text: 'Saved recap.' },
      onUpdateRecap: updateRecap,
      onRecapSaved,
      setEditingRecap,
      setRecapDraft,
      setRecapSaving,
      setRecapEditError,
      setEditedRecap,
      navigationGuard,
      onDone,
      onResume,
      onOpenPastMeeting,
      item: { file: 'b.md' },
      window: {
        toto: {
          recallUpdateRecap: vi.fn(() => {
            throw new Error('The Review test bypassed onUpdateRecap')
          })
        }
      }
    }
    return reviewEditCallbacks(renderValues)
  }

  return {
    state,
    writes,
    updateRecap,
    setEditingRecap,
    setRecapDraft,
    setRecapSaving,
    setRecapEditError,
    setEditedRecap,
    savedPathRef,
    recapEditIdentityRef,
    navigationChoice,
    navigationGuard,
    onDone,
    onResume,
    onOpenPastMeeting,
    onRecapSaved,
    render,
    async cleanup() {
      navigationChoice.resolve('cancel')
      await Promise.resolve()
      for (const write of writes) write.result.resolve({ ok: false, error: 'test cleanup' })
      await Promise.allSettled(writes.map((write) => write.result.promise))
      await new Promise<void>((resolve) => setImmediate(resolve))
      vi.restoreAllMocks()
    }
  }
}

function enterReviewDraft(host: ReturnType<typeof reviewRecapHost>, text: string) {
  host.render().startEditRecap()
  const editor = host.render()
  editor.draftOnChange({ target: { value: text } })
  return host.render()
}

describe('actual Review recap edit callbacks', () => {
  it('preserves B when A resolves, reports false, and saves B only after an explicit retry', async () => {
    const host = reviewRecapHost()
    let saveA: Promise<boolean> | undefined
    let saveB: Promise<boolean> | undefined
    try {
      const editorA = enterReviewDraft(host, 'Submitted A')
      saveA = editorA.saveRecap()
      expect(host.updateRecap).toHaveBeenCalledExactlyOnceWith('a.md', 'Submitted A')
      const writeA = host.writes[0]!

      editorA.draftOnChange({ target: { value: 'Newer B' } })
      const editorB = host.render()
      expect(editorB.recapDirty).toBe(true)
      writeA.result.resolve({ ok: true })

      await expect(saveA).resolves.toBe(false)
      expect(host.state.editedRecap).toEqual({ base: 'Saved recap.', text: 'Submitted A' })
      expect(host.state.recapDraft).toBe('Newer B')
      expect(host.state.editingRecap).toBe(true)
      expect(host.render().recapDirty).toBe(true)
      expect(host.writes).toHaveLength(1)

      saveB = host.render().saveRecap()
      expect(host.updateRecap).toHaveBeenNthCalledWith(2, 'a.md', 'Newer B')
      host.writes[1]!.result.resolve({ ok: true })
      await expect(saveB).resolves.toBe(true)
      expect(host.state.editedRecap).toEqual({ base: 'Saved recap.', text: 'Newer B' })
      expect(host.state.editingRecap).toBe(false)
      expect(host.onRecapSaved.mock.calls).toEqual([['Submitted A'], ['Newer B']])
    } finally {
      await host.cleanup()
      await Promise.allSettled([saveA, saveB].filter((save): save is Promise<boolean> => save !== undefined))
    }
  })

  it('returns false from the actual navigation guard when save A leaves B unsaved', async () => {
    const host = reviewRecapHost()
    let guardedNavigation: Promise<boolean> | undefined
    try {
      const editorA = enterReviewDraft(host, 'Submitted A')
      host.navigationChoice.resolve('save')
      guardedNavigation = editorA.guardRecapEditNavigation()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.updateRecap).toHaveBeenCalledExactlyOnceWith('a.md', 'Submitted A')

      editorA.draftOnChange({ target: { value: 'Newer B' } })
      host.writes[0]!.result.resolve({ ok: true })
      await expect(guardedNavigation).resolves.toBe(false)
      expect(host.state.editingRecap).toBe(true)
      expect(host.render().recapDirty).toBe(true)
    } finally {
      await host.cleanup()
      await Promise.allSettled(
        [guardedNavigation].filter((pending): pending is Promise<boolean> => pending !== undefined)
      )
    }
  })

  it.each([
    { label: 'different text', nextText: 'Reopened B' },
    { label: 'identical text', nextText: 'Submitted A' }
  ])('does not let a pending save close a canceled and reopened $label edit session', async ({ nextText }) => {
    const host = reviewRecapHost()
    let saveA: Promise<boolean> | undefined
    try {
      const editorA = enterReviewDraft(host, 'Submitted A')
      saveA = editorA.saveRecap()
      const writeA = host.writes[0]!
      // The Cancel button is a deliberate discard. Esc on a dirty draft asks first now (Q07, D4-22), tested below.
      editorA.cancelEditRecap()
      expect(host.state.editingRecap).toBe(false)

      host.render().startEditRecap()
      const reopened = host.render()
      reopened.draftOnChange({ target: { value: nextText } })
      const current = host.render()
      writeA.result.resolve({ ok: true })

      await expect(saveA).resolves.toBe(false)
      expect(current.recapDraft).toBe(nextText)
      expect(host.state.recapDraft).toBe(nextText)
      expect(host.state.editingRecap).toBe(true)
      expect(host.state.editedRecap).toEqual({ base: 'Saved recap.', text: 'Submitted A' })
      expect(host.onRecapSaved).toHaveBeenCalledExactlyOnceWith('Submitted A')
    } finally {
      await host.cleanup()
      await Promise.allSettled([saveA].filter((save): save is Promise<boolean> => save !== undefined))
    }
  })

  it.each([
    { label: 'resolved refusal', reject: false },
    { label: 'thrown rejection', reject: true }
  ])('keeps the draft and retry path after a $label', async ({ reject }) => {
    const host = reviewRecapHost()
    let firstSave: Promise<boolean> | undefined
    let retry: Promise<boolean> | undefined
    try {
      const editor = enterReviewDraft(host, 'Retry me')
      firstSave = editor.saveRecap()
      if (reject) host.writes[0]!.result.reject(new Error('offline'))
      else host.writes[0]!.result.resolve({ ok: false, error: 'refused' })
      await expect(firstSave).resolves.toBe(false)
      expect(host.state.editingRecap).toBe(true)
      expect(host.state.recapDraft).toBe('Retry me')
      expect(host.state.recapEditError).toContain(reject ? 'offline' : 'refused')

      retry = host.render().saveRecap()
      expect(host.updateRecap).toHaveBeenNthCalledWith(2, 'a.md', 'Retry me')
      host.writes[1]!.result.resolve({ ok: true })
      await expect(retry).resolves.toBe(true)
      expect(host.state.editingRecap).toBe(false)
      expect(host.state.editedRecap).toEqual({ base: 'Saved recap.', text: 'Retry me' })
    } finally {
      await host.cleanup()
      await Promise.allSettled([firstSave, retry].filter((save): save is Promise<boolean> => save !== undefined))
    }
  })

  it('closes an unchanged edit and returns true after the actual save callback succeeds', async () => {
    const host = reviewRecapHost()
    let save: Promise<boolean> | undefined
    try {
      const editor = enterReviewDraft(host, 'Unchanged')
      save = editor.saveRecap()
      host.writes[0]!.result.resolve({ ok: true })
      await expect(save).resolves.toBe(true)
      expect(host.state.editingRecap).toBe(false)
      expect(host.state.editedRecap).toEqual({ base: 'Saved recap.', text: 'Unchanged' })
    } finally {
      await host.cleanup()
      await Promise.allSettled([save].filter((pending): pending is Promise<boolean> => pending !== undefined))
    }
  })

  it.each([
    { label: 'Done', handler: 'doneOnClick', callback: 'onDone' },
    { label: 'Resume', handler: 'resumeOnClick', callback: 'onResume' },
    { label: 'Recent meeting', handler: 'recentOnClick', callback: 'onOpenPastMeeting' }
  ] as const)('does not navigate from the actual $label callback when save A leaves B dirty', async ({
    handler,
    callback
  }) => {
    const host = reviewRecapHost()
    try {
      const editorA = enterReviewDraft(host, 'Submitted A')
      host.navigationChoice.resolve('save')
      editorA[handler]()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.updateRecap).toHaveBeenCalledExactlyOnceWith('a.md', 'Submitted A')

      editorA.draftOnChange({ target: { value: 'Newer B' } })
      expect(host.render().recapDirty).toBe(true)
      host.writes[0]!.result.resolve({ ok: true })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(host.state.editingRecap).toBe(true)
      expect(host.state.recapDraft).toBe('Newer B')
      expect(host[callback]).not.toHaveBeenCalled()
    } finally {
      await host.cleanup()
    }
  })

  it.each([
    { label: 'Done / newer draft', handler: 'doneOnClick', reopen: false },
    { label: 'Resume / newer draft', handler: 'resumeOnClick', reopen: false },
    { label: 'Recent meeting / newer draft', handler: 'recentOnClick', reopen: false },
    { label: 'Done / same-text reopen', handler: 'doneOnClick', reopen: true },
    { label: 'Resume / same-text reopen', handler: 'resumeOnClick', reopen: true },
    { label: 'Recent meeting / same-text reopen', handler: 'recentOnClick', reopen: true }
  ] as const)('refuses a stale Save choice after a deferred $label dialog', async ({ handler, reopen }) => {
    const host = reviewRecapHost()
    try {
      const editorA = enterReviewDraft(host, 'Submitted A')
      editorA[handler]()
      expect(host.navigationGuard.request).toHaveBeenCalledTimes(1)
      expect(host.updateRecap).not.toHaveBeenCalled()

      const nextText = reopen ? 'Submitted A' : 'Newer B'
      if (reopen) {
        editorA.cancelEditRecap()
        expect(host.state.editingRecap).toBe(false)
        host.render().startEditRecap()
        host.render().draftOnChange({ target: { value: nextText } })
      } else {
        editorA.draftOnChange({ target: { value: nextText } })
      }
      const current = host.render()
      expect(current.recapDraft).toBe(nextText)
      expect(current.recapDirty).toBe(true)

      host.navigationChoice.resolve('save')
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Settle even an incorrect stale submission so RED tests the actual data-loss outcome.
      for (const write of host.writes) write.result.resolve({ ok: true })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(host.state.editingRecap).toBe(true)
      expect(host.state.recapDraft).toBe(nextText)
      expect(host.render().recapDirty).toBe(true)
      expect(host.onDone).not.toHaveBeenCalled()
      expect(host.onResume).not.toHaveBeenCalled()
      expect(host.onOpenPastMeeting).not.toHaveBeenCalled()
      expect(host.updateRecap).not.toHaveBeenCalled()
      expect(host.onRecapSaved).not.toHaveBeenCalled()
      expect(host.state.editedRecap).toBe(null)
    } finally {
      await host.cleanup()
    }
  })

  it.each([
    { label: 'Done', handler: 'doneOnClick', callback: 'onDone' },
    { label: 'Resume', handler: 'resumeOnClick', callback: 'onResume' },
    { label: 'Recent meeting', handler: 'recentOnClick', callback: 'onOpenPastMeeting' }
  ] as const)('saves and navigates after an unchanged deferred $label dialog', async ({ handler, callback }) => {
    const host = reviewRecapHost()
    try {
      const editor = enterReviewDraft(host, 'Submitted A')
      editor[handler]()
      expect(host.navigationGuard.request).toHaveBeenCalledTimes(1)
      expect(host.updateRecap).not.toHaveBeenCalled()
      host.render()
      host.navigationChoice.resolve('save')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.updateRecap).toHaveBeenCalledExactlyOnceWith('a.md', 'Submitted A')
      host.writes[0]!.result.resolve({ ok: true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.state.editingRecap).toBe(false)
      expect(host.state.editedRecap).toEqual({ base: 'Saved recap.', text: 'Submitted A' })
      expect(host[callback]).toHaveBeenCalledTimes(1)
    } finally {
      await host.cleanup()
    }
  })

  // Q07 (D4-22): Esc used to throw a long draft away with no question. Esc on a dirty draft now opens the same
  // "Save recap changes?" sheet as leaving the screen; an unchanged draft still closes at once.
  it('Escape on a dirty recap draft opens the save prompt, and only Discard closes the editor', async () => {
    const host = reviewRecapHost()
    try {
      const editor = enterReviewDraft(host, 'Unsaved words')
      const escape = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() }
      editor.draftOnKeyDown(escape)
      expect(escape.stopPropagation).toHaveBeenCalledExactlyOnceWith()
      expect(host.navigationGuard.request).toHaveBeenCalledTimes(1)
      expect(host.state.editingRecap).toBe(true)
      expect(host.state.recapDraft).toBe('Unsaved words')

      host.navigationChoice.resolve('discard')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.state.editingRecap).toBe(false)
      expect(host.updateRecap).not.toHaveBeenCalled()
    } finally {
      await host.cleanup()
    }
  })

  it('Cancel in the Escape prompt keeps the draft open', async () => {
    const host = reviewRecapHost()
    try {
      const editor = enterReviewDraft(host, 'Unsaved words')
      editor.draftOnKeyDown({ key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() })
      host.navigationChoice.resolve('cancel')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.state.editingRecap).toBe(true)
      expect(host.state.recapDraft).toBe('Unsaved words')
      expect(host.updateRecap).not.toHaveBeenCalled()
    } finally {
      await host.cleanup()
    }
  })

  it('Escape on an unchanged recap draft closes it without asking', async () => {
    const host = reviewRecapHost()
    try {
      host.render().startEditRecap()
      const editor = host.render()
      expect(editor.recapDirty).toBe(false)
      editor.draftOnKeyDown({ key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.navigationGuard.request).not.toHaveBeenCalled()
      expect(host.state.editingRecap).toBe(false)
    } finally {
      await host.cleanup()
    }
  })

  it('does not paint a pending completion onto a different meeting', async () => {
    const host = reviewRecapHost()
    let save: Promise<boolean> | undefined
    try {
      const editorA = enterReviewDraft(host, 'Meeting A edit')
      save = editorA.saveRecap()
      const writeA = host.writes[0]!
      const meetingB = host.render({ savedPath: 'b.md', recapText: 'Meeting B recap.' })
      meetingB.savedPathRefEffect()
      meetingB.savedPathResetEffect()
      const publishedStateCalls = host.setEditedRecap.mock.calls.length

      writeA.result.resolve({ ok: true })
      await expect(save).resolves.toBe(false)
      expect(host.setEditedRecap).toHaveBeenCalledTimes(publishedStateCalls)
      expect(host.onRecapSaved).not.toHaveBeenCalled()
      expect(host.state.editingRecap).toBe(false)
      expect(host.state.editedRecap).toBe(null)
    } finally {
      await host.cleanup()
      await Promise.allSettled([save].filter((pending): pending is Promise<boolean> => pending !== undefined))
    }
  })
})

describe('actual App generated-write to Review manual-edit wiring', () => {
  it.each([
    { lane: 'past', generatedPath: 'a.md' },
    { lane: 'live POSIX', generatedPath: '/synthetic/meetings/a.md' },
    { lane: 'live Windows', generatedPath: 'C:\\synthetic\\meetings\\a.md' }
  ])('orders $lane generation before the reopened Review edit of the same file', async ({ lane, generatedPath }) => {
    const generation = deferred<{ ok: boolean }>()
    const calls: unknown[][] = []
    let storedText = '',
      target: unknown = { file: 'a.md', ownerId: 'a.md', runId: 'generated-a', priorText: '' }
    let pastMeeting = { file: 'a.md', recap: '' }
    const context = vm.createContext({
      Error,
      Promise,
      recapPersistAction,
      recapFileIdentity,
      recapWriteCoordinatorRef: ref(new RecapWriteCoordinator()),
      manualRecapWriteSeqRef: ref(0),
      recapGenTarget: target,
      recapGenId: 'generated-a',
      recapGenRunIdRef: ref('generated-a'),
      recapGenStreaming: false,
      recapGenText: 'Generated notes.',
      recapGenError: null,
      recapGenCompletion: 'complete',
      recapPersistingRef: ref(''),
      setRecapGenTarget: vi.fn((value: unknown) => {
        target = typeof value === 'function' ? value(target) : value
      }),
      setPastMeeting: vi.fn((update: (value: typeof pastMeeting) => typeof pastMeeting) => {
        pastMeeting = update(pastMeeting)
      }),
      setRecapSaveError: vi.fn(),
      // A live generated write starts with the absolute path returned by saveTranscript. Later History
      // reopens the same file under its basename; the actual Review callback must join that write too.
      view: 'review',
      savedPath: generatedPath,
      listen: { lines },
      meetingStartRef: ref(100),
      discardPendingOwnerRef: ref<string | null>(null),
      discardedMeetingRef: ref<string | null>(null),
      deletedTranscriptForDiscardRef: ref<{ ownerId: string; paths: string[] } | null>(null),
      saveRetryTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
      liveRecapWritesRef: ref(new Set<string>()),
      liveRecapTargetRef: ref({ ownerId: '100', runId: 'generated-a', file: null, priorText: '' }),
      answerId: 'generated-a',
      answerStreaming: false,
      answerText: 'Generated notes.',
      answerError: null,
      answerCompletion: 'complete',
      window: {
        toto: {
          recallUpdateRecap: async (...args: unknown[]) => {
            calls.push(args)
            if (args.length === 3) {
              const result = await generation.promise
              storedText = String(args[1])
              return result
            }
            storedText = String(args[1])
            return { ok: true }
          },
          preserveDraftTranscript: async (_startedAt: number) => ({ ok: true }),
          discardSavedTranscript: async (_startedAt: number, _title: string, path?: string) => ({
            ok: true,
            deletedPaths: path ? [path] : []
          }),
          discardDraftTranscript: async (_startedAt: number) => ({ ok: true })
        }
      }
    })
    context.recapWriteKey = callback('recapWriteKey', context)
    const effect = uniqueNode(
      app,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(app) === 'useEffect' &&
        node.arguments[0]
          ?.getText(app)
          .includes(lane === 'past' ? 'const owningId = recapGenId' : "if (view !== 'review') return")
    ) as ts.CallExpression
    const generated = evaluate<() => void>(effect.arguments[0]!.getText(app), context)
    context.updateRecapManually = callback('updateRecapManually', context)
    const onUpdateRecap = reviewProp<(file: string, text: string) => Promise<{ ok: boolean }>>('onUpdateRecap', context)
    const editor = vm.createContext({
      Error,
      savedPath: 'a.md',
      savedPathRef: ref('a.md'),
      recapEditIdentityRef: reviewUseRef('recapEditIdentityRef', { savedPath: 'a.md' }),
      recapSaving: false,
      recapDraft: 'Human annotation.',
      recap: { text: '' },
      onUpdateRecap,
      setRecapSaving: vi.fn(),
      setRecapEditError: vi.fn(),
      setEditedRecap: vi.fn(),
      setEditingRecap: vi.fn(),
      onRecapSaved: vi.fn(),
      window: {
        toto: {
          recallUpdateRecap: vi.fn(() => {
            throw new Error('Bypassed the App ordering boundary')
          })
        }
      }
    })
    editor.recapEditSnapshot = evaluate(namedExpression(review, 'recapEditSnapshot'), editor)
    generated()
    await Promise.resolve()
    const manual = callback<() => Promise<void>>('saveRecap', editor, review)()
    // Let an incorrectly independent manual queue start before unlocking the old generated write.
    await Promise.resolve()
    const beforeGenerationFinishes = calls.map((args) => [...args])
    generation.resolve({ ok: true })
    await manual
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(beforeGenerationFinishes).toEqual([[generatedPath, 'Generated notes.', 'complete']])
    expect(calls).toEqual([
      [generatedPath, 'Generated notes.', 'complete'],
      ['a.md', 'Human annotation.']
    ])
    expect(storedText).toBe('Human annotation.')
    expect(editor.onRecapSaved).toHaveBeenCalledExactlyOnceWith('Human annotation.')
    expect(context.setPastMeeting).not.toHaveBeenCalled()
    expect(editor.window.toto.recallUpdateRecap).not.toHaveBeenCalled()
    expect(target).toBeNull()
  })
})

function draftAutosaveEffect(source = app): ts.CallExpression {
  const imported = source.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './lib/draft-autosave'
  )
  const binding = imported[0]?.importClause
  if (
    imported.length !== 1 ||
    !binding ||
    binding.isTypeOnly ||
    !binding.namedBindings ||
    !ts.isNamedImports(binding.namedBindings) ||
    !binding.namedBindings.elements.some(
      (item) => item.name.text === 'startDraftAutosave' && !item.propertyName && !item.isTypeOnly
    )
  )
    throw new Error('Expected real autosave lifecycle import')
  const effect = uniqueNode(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[0] !== undefined &&
      ts.isArrowFunction(node.arguments[0]) &&
      ts.isBlock(node.arguments[0].body) &&
      node.arguments[0].body.statements.some(
        (statement) =>
          ts.isReturnStatement(statement) &&
          statement.expression !== undefined &&
          ts.isCallExpression(statement.expression) &&
          statement.expression.expression.getText(source) === 'startDraftAutosave'
      )
  ) as ts.CallExpression
  if (effect.arguments[1]?.getText(source).replace(/\s/g, '') !== '[listen.listening,mode]')
    throw new Error('Autosave lifecycle must keep the listening and mode dependencies')
  return effect
}

describe('actual App periodic draft autosave ownership', () => {
  function autosaveHost(listening = true, currentLines = lines) {
    const writes: ReturnType<typeof deferred<SaveDraftTranscriptResult>>[] = []
    const ticks: Array<() => void> = []
    const cleanups: Array<() => void> = []
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((tick) => {
      ticks.push(tick as () => void)
      return ticks.length as unknown as ReturnType<typeof setInterval>
    })
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const saveDraftTranscript = vi.fn((_payload: SaveMeeting) => {
      const write = deferred<SaveDraftTranscriptResult>()
      writes.push(write)
      return write.promise
    })
    const context = vm.createContext({
      TITLE_BUDGET: 50,
      mode: 'meeting',
      listen: { listening },
      startDraftAutosave,
      meetingStartRef: ref(100),
      autosaveLinesRef: ref(currentLines),
      autosaveFailsRef: ref(0),
      setAutosaveWarn: vi.fn(),
      window: { toto: { saveDraftTranscript } },
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy
    })
    context.defaultMeetingTitle = callback('defaultMeetingTitle', context)
    const node = draftAutosaveEffect()
    const effect = evaluate<() => (() => void) | undefined>(node.arguments[0]!.getText(app), context)
    return {
      context,
      saveDraftTranscript,
      writes,
      ticks,
      start() {
        const cleanup = effect()
        if (cleanup) cleanups.push(cleanup)
        return cleanup
      },
      async settle(index: number, outcome: 'success' | 'failure' | 'failed' | 'disabled' | 'missing') {
        if (outcome === 'success') writes[index]!.resolve({ status: 'saved' })
        else if (outcome === 'failed' || outcome === 'disabled') writes[index]!.resolve({ status: outcome })
        else if (outcome === 'missing') writes[index]!.resolve(undefined as unknown as SaveDraftTranscriptResult)
        else writes[index]!.reject(new Error('Synthetic draft IPC failure'))
        await new Promise<void>((resolve) => setImmediate(resolve))
      },
      async dispose() {
        cleanups.forEach((cleanup) => cleanup())
        writes.forEach((write) => write.resolve({ status: 'disabled' }))
        await new Promise<void>((resolve) => setImmediate(resolve))
        setIntervalSpy.mockRestore()
        clearIntervalSpy.mockRestore()
      }
    }
  }

  it.each([
    { retirement: 'changed meeting without cleanup', outcome: 'success' },
    { retirement: 'changed meeting without cleanup', outcome: 'failure' },
    { retirement: 'changed meeting without cleanup', outcome: 'failed' },
    { retirement: 'changed meeting without cleanup', outcome: 'disabled' },
    { retirement: 'same meeting after cleanup', outcome: 'success' },
    { retirement: 'same meeting after cleanup', outcome: 'failure' },
    { retirement: 'same meeting after cleanup', outcome: 'failed' },
    { retirement: 'same meeting after cleanup', outcome: 'disabled' }
  ] as const)('a late $outcome cannot change the active warning after $retirement', async ({ retirement, outcome }) => {
    const h = autosaveHost()
    try {
      const cleanup = h.start()!
      h.ticks[0]!() // A remains held while the active owner accumulates its own failures.
      let activeTick = h.ticks[0]!
      if (retirement === 'changed meeting without cleanup') h.context.meetingStartRef.current = 200
      else {
        cleanup()
        expect(h.context.clearInterval).toHaveBeenCalledExactlyOnceWith(1)
        h.start() // Same startedAt deliberately proves the lifetime fence independently of identity.
        activeTick = h.ticks[1]!
      }
      activeTick()
      await h.settle(1, 'failure')
      activeTick()
      await h.settle(2, 'failure')
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(true)
      h.context.setAutosaveWarn.mockClear()
      await h.settle(0, outcome)
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
    } finally {
      await h.dispose()
    }
  })

  it('preserves the actual interval, payload, two-failure threshold and current-success reset', async () => {
    const h = autosaveHost()
    try {
      h.start()
      expect(h.context.setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60_000)
      expect(h.context.autosaveFailsRef.current).toBe(0)
      expect(h.context.setAutosaveWarn).toHaveBeenCalledExactlyOnceWith(false)
      h.context.setAutosaveWarn.mockClear()
      h.ticks[0]!()
      expect(h.saveDraftTranscript).toHaveBeenCalledExactlyOnceWith({
        title: 'Synthetic meeting A speech.',
        mode: 'meeting',
        startedAt: 100,
        lines,
        recap: ''
      })
      await h.settle(0, 'failure')
      expect(h.context.autosaveFailsRef.current).toBe(1)
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
      h.ticks[0]!()
      await h.settle(1, 'failure')
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenCalledExactlyOnceWith(true)
      h.ticks[0]!()
      await h.settle(2, 'success')
      expect(h.context.autosaveFailsRef.current).toBe(0)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(false)
    } finally {
      await h.dispose()
    }
  })

  it('counts failed receipts and treats retention-disabled as neither saved nor failed', async () => {
    const h = autosaveHost()
    try {
      h.start()
      h.ticks[0]!()
      await h.settle(0, 'failed')
      h.ticks[0]!()
      await h.settle(1, 'disabled')
      expect(h.context.autosaveFailsRef.current).toBe(1)
      h.ticks[0]!()
      await h.settle(2, 'failed')
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(true)
      h.context.setAutosaveWarn.mockClear()
      h.ticks[0]!()
      await h.settle(3, 'disabled')
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
    } finally {
      await h.dispose()
    }
  })

  it('reads updated transcript and meeting refs without restarting the original timer', async () => {
    const h = autosaveHost()
    try {
      h.start()
      const updated: TranscriptLine[] = [{ speaker: 'them', text: 'Latest synthetic speech.', t: 2 }]
      h.context.autosaveLinesRef.current = updated
      h.context.meetingStartRef.current = 200
      h.ticks[0]!()
      expect(h.context.setInterval).toHaveBeenCalledTimes(1)
      expect(h.saveDraftTranscript).toHaveBeenCalledExactlyOnceWith({
        title: 'Latest synthetic speech.',
        mode: 'meeting',
        startedAt: 200,
        lines: updated,
        recap: ''
      })
      expect(h.saveDraftTranscript.mock.calls[0]![0].lines).toBe(updated)
      await h.settle(0, 'success')
    } finally {
      await h.dispose()
    }
  })

  it('counts a missing receipt as failure instead of acknowledging a save', async () => {
    const h = autosaveHost()
    try {
      h.start()
      h.context.setAutosaveWarn.mockClear()
      h.ticks[0]!()
      await h.settle(0, 'missing')
      expect(h.context.autosaveFailsRef.current).toBe(1)
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
      h.ticks[0]!()
      await h.settle(1, 'missing')
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenCalledExactlyOnceWith(true)
    } finally {
      await h.dispose()
    }
  })

  it('requires the real lifecycle import, returned cleanup and stable effect dependencies', () => {
    const source = app.getFullText()
    const mutations = [
      ['import { startDraftAutosave }', 'import type { startDraftAutosave }'],
      ["from './lib/draft-autosave'", "from './lib/unused-draft-autosave'"],
      ['return startDraftAutosave(', 'startDraftAutosave('],
      ['[listen.listening, mode]', '[listen.listening, mode, listen.lines]']
    ] as const
    for (const [before, after] of mutations) {
      expect(source).toContain(before)
      const changed = source.replace(before, after)
      expect(changed).not.toBe(source)
      expect(() =>
        draftAutosaveEffect(ts.createSourceFile('App', changed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX))
      ).toThrow()
    }
  })

  it('does not schedule autosave while not listening', async () => {
    const h = autosaveHost(false)
    try {
      expect(h.start()).toBeUndefined()
      expect(h.context.setInterval).not.toHaveBeenCalled()
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
      expect(h.saveDraftTranscript).not.toHaveBeenCalled()
    } finally {
      await h.dispose()
    }
  })

  it('skips an empty transcript tick and clears the actual interval on cleanup', async () => {
    const h = autosaveHost(true, [])
    try {
      const cleanup = h.start()!
      h.ticks[0]!()
      expect(h.saveDraftTranscript).not.toHaveBeenCalled()
      cleanup()
      expect(h.context.clearInterval).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      await h.dispose()
    }
  })
})
