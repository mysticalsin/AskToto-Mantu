import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { transcriptStateKey } from '@shared/hash'
import { transcriptTail } from './lib/ask-context'
import { readModuleSource } from '../../test-helpers/module-source'

const appModule = readModuleSource(__dirname, './App')
const app = ts.createSourceFile(appModule.path, appModule.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

const MEETING_A_TEXT = 'THEM: The launch is on Friday.\nTHEM: Please share the draft today.'
const MEETING_A_LINES = [
  { speaker: 'them', text: 'The launch is on Friday.', t: 1 },
  { speaker: 'them', text: 'Please share the draft today.', t: 2 }
]

type SpecAnswer = {
  id: string
  text: string
  streaming: boolean
  error: string | null
}

type ReactElement = { type: unknown; props: Record<string, unknown> }

function uniqueNode(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (found.length !== 1) throw new Error(`Expected one actual App boundary, found ${found.length}`)
  return found[0]!
}

function namedExpression(name: string): string {
  const declaration = uniqueNode(
    app,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(app) === name
  ) as ts.VariableDeclaration
  const initializer = declaration.initializer
  if (!initializer) throw new Error(`Missing ${name} initializer`)
  return ts.isCallExpression(initializer) && initializer.expression.getText(app) === 'useCallback'
    ? initializer.arguments[0]!.getText(app)
    : initializer.getText(app)
}

function hookExpressions(
  hookName: 'useEffect' | 'useMemo',
  predicate: (callback: ts.ArrowFunction) => boolean
): { callback: string; dependencies: string } {
  const call = uniqueNode(
    app,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(app) === hookName &&
      node.arguments[0] !== undefined &&
      ts.isArrowFunction(node.arguments[0]) &&
      predicate(node.arguments[0])
  ) as ts.CallExpression
  if (!call.arguments[1]) throw new Error(`${hookName} boundary is missing dependencies`)
  return { callback: call.arguments[0]!.getText(app), dependencies: call.arguments[1].getText(app) }
}

function namedHookExpressions(
  name: string,
  hookName: 'useEffect' | 'useMemo'
): { callback: string; dependencies: string } {
  const declaration = uniqueNode(
    app,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(app) === name
  ) as ts.VariableDeclaration
  if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) {
    throw new Error(`Missing ${name} ${hookName} call`)
  }
  const call = declaration.initializer
  if (call.expression.getText(app) !== hookName || !call.arguments[0] || !call.arguments[1]) {
    throw new Error(`${name} is not a complete ${hookName} boundary`)
  }
  return { callback: call.arguments[0].getText(app), dependencies: call.arguments[1].getText(app) }
}

function evaluate<T>(expression: string, context: vm.Context): T {
  const code = ts.transpileModule(`globalThis.result = (${expression});`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      jsx: ts.JsxEmit.React
    }
  }).outputText
  vm.runInContext(code, context, { timeout: 1_000 })
  return context.result as T
}

function callback<T>(name: string, context: vm.Context): T {
  return evaluate<T>(namedExpression(name), context)
}

function optionalCallback<T>(name: string, context: vm.Context): T | undefined {
  let exists = false
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === name) exists = true
    ts.forEachChild(node, visit)
  }
  visit(app)
  return exists ? callback<T>(name, context) : undefined
}

function ref<T>(current: T): { current: T } {
  return { current }
}

function scheduler<T>(
  callbackExpression: string,
  dependenciesExpression: string,
  context: vm.Context,
  invoke: (callback: () => T) => T
): { render: () => T | undefined } {
  let previous: unknown[] | undefined
  let value: T | undefined
  return {
    render() {
      const dependencies = evaluate<unknown[]>(dependenciesExpression, context)
      const changed =
        !previous ||
        dependencies.length !== previous.length ||
        dependencies.some((dependency, index) => !Object.is(dependency, previous![index]))
      if (changed) {
        previous = dependencies
        const run = evaluate<() => T>(callbackExpression, context)
        value = invoke(run)
      }
      return value
    }
  }
}

function actualSpeculationEffect(context: vm.Context): { render: () => void | undefined } {
  const effect = hookExpressions(
    'useEffect',
    (callback) =>
      callback.getText(app).includes('specWatermarkRef.current') && callback.getText(app).includes('speculative.run')
  )
  return scheduler<void>(effect.callback, effect.dependencies, context, (run) => run())
}

function actualCopilotMemo(context: vm.Context): { render: () => ReactElement | undefined } {
  const memo = namedHookExpressions('copilotBody', 'useMemo')
  return scheduler<ReactElement>(memo.callback, memo.dependencies, context, (render) => render())
}

function makeHarness() {
  const deferredStateUpdates: Array<() => void> = []
  const events: string[] = []
  const runRequests: Array<{ mode: string; transcript: string }> = []
  let transcript = MEETING_A_TEXT
  let nextRun = 0
  let context!: vm.Context & Record<string, unknown>
  let reentrantAdoption: boolean | null = null
  const defer = (update: () => void): void => {
    deferredStateUpdates.push(update)
  }
  const initialAnswer: SpecAnswer = {
    id: 'spec-a',
    text: 'A-only suggestion that must not cross the meeting boundary.',
    streaming: false,
    error: null
  }
  const initialWatermark = {
    lineCount: MEETING_A_LINES.length,
    at: 1,
    key: transcriptStateKey(MEETING_A_TEXT),
    meetingStart: 41,
    runId: 'spec-a'
  }
  const listenStart = vi.fn((..._args: unknown[]) => {
    events.push('listen.start')
  })
  const speculativeRun = vi.fn((request: { mode: string; transcript: string }) => {
    runRequests.push(request)
    nextRun += 1
    events.push(`speculative.run:${nextRun}`)
    return `spec-b-${nextRun}`
  })
  const speculativeClear = vi.fn(() => {
    events.push('speculative.clear')
    if (context.tryAdoptSpeculative) {
      reentrantAdoption = (context.tryAdoptSpeculative as () => boolean)()
    }
    // Model deferred React publication deliberately: clear cannot erase A before the projection guard runs.
    defer(() => {
      const speculative = context.speculative as { answer: SpecAnswer | null }
      speculative.answer = null
    })
  })
  const updates = {
    setShowSpec: vi.fn((value: boolean) => defer(() => (context.showSpec = value))),
    setOperatorGateNotice: vi.fn(),
    setView: vi.fn(),
    setCollapsed: vi.fn(),
    setRecapSkipped: vi.fn(),
    setSavedPath: vi.fn(),
    setSaveError: vi.fn(),
    setSaveAttempts: vi.fn(),
    setSaveGaveUp: vi.fn(),
    setTranscriptShown: vi.fn(),
    setDiscardPendingOwner: vi.fn(),
    setInput: vi.fn(),
    setCaptureError: vi.fn(),
    setPastMeeting: vi.fn()
  }
  const lines = MEETING_A_LINES.map((line) => ({ ...line }))
  context = vm.createContext({
    Date: { now: () => 100_000 },
    React: {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props: { ...(props ?? {}), ...(children.length ? { children } : {}) }
      })
    },
    Copilot: 'Copilot',
    transcriptStateKey,
    transcriptTail,
    ...updates,
    settings: {
      instantSuggestions: true,
      providerReady: true,
      localSuggestReady: false,
      suggestEverySec: 8,
      audioSource: 'both',
      asrQuality: 'best',
      asrLanguage: 'en',
      profile: {},
      playListenChime: false,
      showLiveTranscript: false
    },
    liveError: null,
    listen: {
      listening: true,
      lines,
      loading: false,
      loadingPct: 0,
      error: null,
      text: vi.fn(() => transcript),
      clear: vi.fn(() => events.push('listen.clear')),
      start: listenStart,
      stop: vi.fn(() => Promise.resolve())
    },
    ask: {
      answer: null,
      cancel: vi.fn(() => null),
      clear: vi.fn(),
      fail: vi.fn()
    },
    suggest: { answer: null, run: vi.fn(), clear: vi.fn(), cancel: vi.fn() },
    speculative: { answer: initialAnswer, run: speculativeRun, clear: speculativeClear },
    followup: { clear: vi.fn() },
    coaching: { clear: vi.fn() },
    booking: { clear: vi.fn() },
    showSpec: true,
    mode: 'meeting',
    autosaveWarn: false,
    micSpeakerLabel: () => 'You',
    endReview: vi.fn(),
    specWatermarkRef: ref(initialWatermark),
    meetingStartRef: ref(41),
    meetingPauseRef: ref(0),
    stoppingRef: ref(false),
    writeupSpansRef: ref({ reset: vi.fn() }),
    pendingRecapRef: ref(false),
    cancelledRef: ref(false),
    savedRef: ref('saved-a'),
    savingPromiseRef: ref<Promise<string | null> | null>(null),
    liveRecapTargetRef: ref({ ownerId: '41', runId: 'recap-a', file: null, priorText: '' }),
    persistLiveMeetingOnExitRef: ref(vi.fn()),
    discardedMeetingRef: ref<string | null>('41'),
    historyRef: ref([]),
    copilotHistoryRef: ref([]),
    pendingUserRef: ref(null),
    view: 'copilot',
    collapsed: false,
    input: '',
    captureError: null,
    transcriptShown: false,
    pastMeeting: null,
    cloudConsentFlow: {
      authorizeSettingsStart: vi.fn(() => true)
    },
    listenOperatorGateNotice: vi.fn(() => null),
    nextMeetingStart: (current: number) => current + 1,
    freshMeetingPauseClock: () => 0,
    resolveListenEngine: () => 'synthetic-engine',
    playListenChime: vi.fn(),
    beginOwnedMeetingExit: vi.fn(),
    persistAndRetireLiveMeeting: vi.fn(() => Promise.resolve()),
    window: { toto: { resetAskContext: vi.fn(() => Promise.resolve()) } }
  })
  const tryAdoptSpeculative = callback<() => boolean>('tryAdoptSpeculative', context)
  context.tryAdoptSpeculative = tryAdoptSpeculative
  const retireSpeculativeMeeting = optionalCallback<() => void>('retireSpeculativeMeeting', context)
  if (retireSpeculativeMeeting) context.retireSpeculativeMeeting = retireSpeculativeMeeting

  return {
    context,
    events,
    runRequests,
    initialAnswer,
    initialWatermark,
    listenStart,
    speculativeRun,
    speculativeClear,
    reentrantAdoption: () => reentrantAdoption,
    startListen: callback<(rescueExisting?: boolean) => void>('startListen', context),
    reset: callback<() => void>('reset', context),
    tryAdoptSpeculative,
    speculationEffect: actualSpeculationEffect(context),
    copilotMemo: actualCopilotMemo(context),
    updateTranscript(nextText: string, nextLines: Array<{ speaker: string; text: string; t: number }>) {
      transcript = nextText
      ;(context.listen as { lines: unknown[] }).lines = nextLines
    },
    setAnswer(answer: SpecAnswer | null) {
      ;(context.speculative as { answer: SpecAnswer | null }).answer = answer
    },
    setGate(options: { operatorRefusal?: string | null; consentAllowed?: boolean }) {
      context.listenOperatorGateNotice = vi.fn(() => options.operatorRefusal ?? null)
      ;(context.cloudConsentFlow as { authorizeSettingsStart: ReturnType<typeof vi.fn> }).authorizeSettingsStart =
        vi.fn(() => options.consentAllowed ?? true)
    },
    async settle() {
      while (deferredStateUpdates.length) deferredStateUpdates.shift()!()
      await Promise.resolve()
      vi.restoreAllMocks()
    }
  }
}

function selectedSuggestion(element: ReactElement | undefined): SpecAnswer | null {
  return (element?.props.suggestion as SpecAnswer | null | undefined) ?? null
}

function prepareEligibleGenerationCase(
  h: ReturnType<typeof makeHarness>,
  options: { instantSuggestions?: boolean } = {}
) {
  const settings = h.context.settings as {
    instantSuggestions: boolean
    providerReady: boolean
    localSuggestReady: boolean
    suggestEverySec: number
  }
  settings.instantSuggestions = options.instantSuggestions ?? true
  settings.providerReady = true
  settings.localSuggestReady = false
  settings.suggestEverySec = 8

  const listen = h.context.listen as { listening: boolean }
  listen.listening = true
  h.updateTranscript(
    MEETING_A_TEXT,
    MEETING_A_LINES.map((line) => ({ ...line, speaker: 'them' }))
  )

  const ask = h.context.ask as { answer: SpecAnswer | null }
  const suggest = h.context.suggest as { answer: SpecAnswer | null }
  ask.answer = null
  suggest.answer = null
  h.setAnswer({ ...h.initialAnswer, streaming: false })

  const watermark = h.context.specWatermarkRef as { current: Record<string, unknown> }
  watermark.current = { ...h.initialWatermark, lineCount: 0, at: 1 }
}

describe('actual App speculative meeting lifecycle', () => {
  it('retires A on accepted same-text replacement and lets equal-line-count B start fresh work', async () => {
    const h = makeHarness()
    try {
      h.speculationEffect.render()
      expect(selectedSuggestion(h.copilotMemo.render())?.id).toBe('spec-a')

      h.startListen(false)
      const adoptedBeforeDeferredUpdates = h.tryAdoptSpeculative()
      const staleAnswerRemainsPublic = (h.context.speculative as { answer: SpecAnswer }).answer === h.initialAnswer
      const staleVisibleStateRemains = h.context.showSpec === true

      // A new array models B's React transcript update while keeping the exact same text and line count.
      h.updateTranscript(
        MEETING_A_TEXT,
        MEETING_A_LINES.map((line) => ({ ...line }))
      )
      const projectedStaleA = selectedSuggestion(h.copilotMemo.render())
      h.speculationEffect.render()
      const pendingRunId = h.runRequests.length ? `spec-b-${h.runRequests.length}` : ''
      if (pendingRunId) {
        h.setAnswer({ ...h.initialAnswer, id: pendingRunId, streaming: true })
      }
      const projectedWhileBIsPending = selectedSuggestion(h.copilotMemo.render())
      const staleAnswerCannotBeAdopted = h.tryAdoptSpeculative()

      expect({
        listeningStartedSynchronously: h.listenStart.mock.calls.length,
        oldAnswerWasNotEagerlyErased: staleAnswerRemainsPublic,
        oldVisibleStateWasNotEagerlyErased: staleVisibleStateRemains,
        oldAnswerWasNotAdopted: adoptedBeforeDeferredUpdates,
        staleAWasNotProjected: projectedStaleA?.id ?? null,
        freshEqualLineCountRunCount: h.speculativeRun.mock.calls.length,
        pendingAAnswerIsNotProjected: projectedWhileBIsPending?.id ?? null,
        staleAnswerCannotBeAdopted
      }).toEqual({
        listeningStartedSynchronously: 1,
        oldAnswerWasNotEagerlyErased: true,
        oldVisibleStateWasNotEagerlyErased: true,
        oldAnswerWasNotAdopted: false,
        staleAWasNotProjected: null,
        freshEqualLineCountRunCount: 1,
        pendingAAnswerIsNotProjected: null,
        staleAnswerCannotBeAdopted: false
      })

      const currentRunId = `spec-b-${h.runRequests.length}`
      h.setAnswer({ id: currentRunId, text: 'Fresh B suggestion.', streaming: false, error: null })
      expect(h.tryAdoptSpeculative()).toBe(true)
      expect(selectedSuggestion(h.copilotMemo.render())?.id).toBe(currentRunId)
      expect(h.runRequests).toEqual([{ mode: 'suggest', transcript: MEETING_A_TEXT }])
      expect(h.events.indexOf('listen.start')).toBeGreaterThan(h.events.indexOf('speculative.clear'))
      expect(h.reentrantAdoption()).toBe(false)
    } finally {
      await h.settle()
    }
  })

  it.each([
    { gate: 'Operator', operatorRefusal: 'Listen is unavailable.', consentAllowed: true },
    { gate: 'cloud consent', operatorRefusal: null, consentAllowed: false }
  ])('$gate refusal preserves A without clearing or starting capture', async ({ operatorRefusal, consentAllowed }) => {
    const h = makeHarness()
    try {
      h.setGate({ operatorRefusal, consentAllowed })
      const originalWatermark = h.context.specWatermarkRef as { current: unknown }
      const originalValue = originalWatermark.current
      h.startListen(false)
      expect(h.speculativeClear).not.toHaveBeenCalled()
      expect(h.listenStart).not.toHaveBeenCalled()
      expect((h.context.speculative as { answer: SpecAnswer }).answer).toBe(h.initialAnswer)
      expect(originalWatermark.current).toBe(originalValue)
    } finally {
      await h.settle()
    }
  })

  it('retires speculation on reset even if a late A completion is still published', async () => {
    const h = makeHarness()
    try {
      h.setAnswer({ ...h.initialAnswer, streaming: true })
      const pendingBeforeReset = (h.context.speculative as { answer: SpecAnswer }).answer.streaming
      h.reset()
      expect(h.speculativeClear).toHaveBeenCalledOnce()
      h.setAnswer({ ...h.initialAnswer, streaming: false, text: 'Late A completion.' })
      h.updateTranscript(
        MEETING_A_TEXT,
        MEETING_A_LINES.map((line) => ({ ...line }))
      )
      const projected = selectedSuggestion(h.copilotMemo.render())
      expect({
        pendingBeforeReset,
        ownerAdvanced: (h.context.meetingStartRef as { current: number }).current !== 41,
        staleAnswerStillAvailable: (h.context.speculative as { answer: SpecAnswer }).answer.id === 'spec-a',
        adopted: h.tryAdoptSpeculative(),
        projectedId: projected?.id ?? null
      }).toEqual({
        pendingBeforeReset: true,
        ownerAdvanced: true,
        staleAnswerStillAvailable: true,
        adopted: false,
        projectedId: null
      })
    } finally {
      await h.settle()
    }
  })

  it('rejects a superseded run and changed transcript but adopts the current completed run', async () => {
    const h = makeHarness()
    try {
      const watermark = h.context.specWatermarkRef as { current: Record<string, unknown> }
      watermark.current = {
        ...h.initialWatermark,
        meetingStart: (h.context.meetingStartRef as { current: number }).current,
        runId: 'spec-current'
      }
      expect(h.tryAdoptSpeculative()).toBe(false)
      expect(selectedSuggestion(h.copilotMemo.render())).toBeNull()

      h.setAnswer({ id: 'spec-current', text: 'Current answer.', streaming: true, error: null })
      expect(h.tryAdoptSpeculative()).toBe(false)
      h.setAnswer({ id: 'spec-current', text: 'Current answer.', streaming: false, error: null })
      expect(h.tryAdoptSpeculative()).toBe(true)
      expect(selectedSuggestion(h.copilotMemo.render())?.id).toBe('spec-current')

      h.updateTranscript(`${MEETING_A_TEXT}\nTHEM: Changed the plan.`, [
        ...MEETING_A_LINES.map((line) => ({ ...line })),
        { speaker: 'them', text: 'Changed the plan.', t: 3 }
      ])
      expect(h.tryAdoptSpeculative()).toBe(false)
      expect(selectedSuggestion(h.copilotMemo.render())).toBeNull()
    } finally {
      await h.settle()
    }
  })

  it('does not adopt or generate when instant suggestions are disabled', async () => {
    const h = makeHarness()
    try {
      const settings = h.context.settings as { instantSuggestions: boolean }
      settings.instantSuggestions = false
      expect(h.tryAdoptSpeculative()).toBe(false)

      prepareEligibleGenerationCase(h, { instantSuggestions: false })
      h.speculationEffect.render()
      expect(h.runRequests).toEqual([])

      settings.instantSuggestions = true
      h.speculationEffect.render()
      const expected = [{ mode: 'suggest', transcript: MEETING_A_TEXT }]
      expect(h.runRequests).toEqual(expected)

      h.speculationEffect.render()
      expect(h.runRequests).toEqual(expected)
    } finally {
      await h.settle()
    }
  })

  it.each([
    {
      guard: 'cloud provider readiness',
      block(h: ReturnType<typeof makeHarness>) {
        const settings = h.context.settings as { providerReady: boolean; localSuggestReady: boolean }
        settings.providerReady = false
        settings.localSuggestReady = false
      },
      release(h: ReturnType<typeof makeHarness>) {
        const settings = h.context.settings as { providerReady: boolean; localSuggestReady: boolean }
        settings.providerReady = true
      }
    },
    {
      guard: 'local-only provider readiness',
      block(h: ReturnType<typeof makeHarness>) {
        const settings = h.context.settings as { providerReady: boolean; localSuggestReady: boolean }
        settings.providerReady = false
        settings.localSuggestReady = false
      },
      release(h: ReturnType<typeof makeHarness>) {
        const settings = h.context.settings as { providerReady: boolean; localSuggestReady: boolean }
        settings.localSuggestReady = true
      }
    },
    {
      guard: 'the other-speaker condition',
      block(h: ReturnType<typeof makeHarness>) {
        h.updateTranscript(
          MEETING_A_TEXT,
          MEETING_A_LINES.map((line) => ({ ...line, speaker: 'you' }))
        )
      },
      release(h: ReturnType<typeof makeHarness>) {
        h.updateTranscript(
          MEETING_A_TEXT,
          MEETING_A_LINES.map((line) => ({ ...line, speaker: 'them' }))
        )
      }
    },
    {
      guard: 'the throttle',
      block(h: ReturnType<typeof makeHarness>) {
        const watermark = h.context.specWatermarkRef as { current: { at: number } }
        watermark.current.at = 99_500
      },
      release(h: ReturnType<typeof makeHarness>) {
        const watermark = h.context.specWatermarkRef as { current: { at: number } }
        watermark.current.at = 92_000
        h.updateTranscript(
          MEETING_A_TEXT,
          MEETING_A_LINES.map((line) => ({ ...line, speaker: 'them' }))
        )
      }
    },
    {
      guard: 'ask answer streaming',
      block(h: ReturnType<typeof makeHarness>) {
        const ask = h.context.ask as { answer: SpecAnswer | null }
        ask.answer = { ...h.initialAnswer, id: 'ask-visible', text: '', streaming: true }
      },
      release(h: ReturnType<typeof makeHarness>) {
        const ask = h.context.ask as { answer: SpecAnswer | null }
        if (!ask.answer) throw new Error('ask streaming blocker was not configured')
        ask.answer = { ...ask.answer, streaming: false }
      }
    },
    {
      guard: 'suggest answer streaming',
      block(h: ReturnType<typeof makeHarness>) {
        const suggest = h.context.suggest as { answer: SpecAnswer | null }
        suggest.answer = { ...h.initialAnswer, id: 'suggest-visible', text: '', streaming: true }
      },
      release(h: ReturnType<typeof makeHarness>) {
        const suggest = h.context.suggest as { answer: SpecAnswer | null }
        if (!suggest.answer) throw new Error('suggest streaming blocker was not configured')
        suggest.answer = { ...suggest.answer, streaming: false }
      }
    },
    {
      guard: 'speculative answer streaming',
      block(h: ReturnType<typeof makeHarness>) {
        h.setAnswer({ ...h.initialAnswer, streaming: true })
      },
      release(h: ReturnType<typeof makeHarness>) {
        const speculative = h.context.speculative as { answer: SpecAnswer | null }
        if (!speculative.answer) throw new Error('speculative streaming blocker was not configured')
        h.setAnswer({ ...speculative.answer, streaming: false })
      }
    },
    {
      guard: 'the line-count watermark',
      block(h: ReturnType<typeof makeHarness>) {
        const watermark = h.context.specWatermarkRef as { current: { lineCount: number } }
        watermark.current.lineCount = MEETING_A_LINES.length
      },
      release(h: ReturnType<typeof makeHarness>) {
        const watermark = h.context.specWatermarkRef as { current: { lineCount: number } }
        watermark.current.lineCount = 0
        h.updateTranscript(
          MEETING_A_TEXT,
          MEETING_A_LINES.map((line) => ({ ...line, speaker: 'them' }))
        )
      }
    }
  ])('blocks on $guard alone, then issues one request after release', async ({ block, release }) => {
    const h = makeHarness()
    try {
      prepareEligibleGenerationCase(h)
      block(h)
      h.speculationEffect.render()
      expect(h.runRequests).toEqual([])

      release(h)
      h.speculationEffect.render()
      const expected = [{ mode: 'suggest', transcript: MEETING_A_TEXT }]
      expect(h.runRequests).toEqual(expected)

      h.speculationEffect.render()
      expect(h.runRequests).toEqual(expected)
    } finally {
      await h.settle()
    }
  })
})
