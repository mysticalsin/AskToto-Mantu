import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptLine, WriteupSpanPayload } from '@shared/ipc'
import { WriteupSpans } from './lib/writeup-spans'

// M2-0430: executes App's actual maybeFireRecap (the callback that runs once the post-Stop drain completes)
// without booting App, the same way app-recap-lifecycle.test.ts runs its boundary callbacks. The host only
// supplies refs, settings and the two IPC-facing effects: the live transcript save and the recap request.
const appPath = join(__dirname, 'App.tsx')
const app = ts.createSourceFile(appPath, readFileSync(appPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function callbackSource(name: string): string {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(app)
  if (found.length !== 1) throw new Error(`Expected one ${name}, found ${found.length}`)
  const init = (found[0] as ts.VariableDeclaration).initializer!
  if (!ts.isCallExpression(init) || init.expression.getText(app) !== 'useCallback') throw new Error(`${name} is not a useCallback`)
  return init.arguments[0]!.getText(app)
}

function evaluate<T>(expression: string, context: vm.Context): T {
  const code = ts.transpileModule(`globalThis.result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  vm.runInContext(code, context, { timeout: 1_000 })
  return context.result as T
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const ref = <T>(current: T) => ({ current })
const lines: TranscriptLine[] = [{ speaker: 'them', text: 'Synthetic closing remark.', t: 1 }]

function host(settings: Record<string, unknown>) {
  const events: string[] = []
  const save = deferred<string | null>()
  const spans: WriteupSpanPayload[] = []
  let clock = 1_000
  const writeupSpans = new WriteupSpans((p) => spans.push(p), () => clock)
  writeupSpans.stop() // endReview's Stop click
  const context = vm.createContext({
    Promise, String,
    pendingRecapRef: ref(true),
    listen: { listening: false, text: () => 'THEM: Synthetic closing remark.', lines },
    meetingStartRef: ref(100),
    liveRecapTargetRef: ref(null),
    writeupSpansRef: ref(writeupSpans),
    saveLiveMeetingNowRef: ref(vi.fn((saved: TranscriptLine[], started: number, recap: string) => {
      events.push(`save:${started}:${saved.length}:${JSON.stringify(recap)}`)
      return save.promise
    })),
    ask: {
      run: vi.fn((req: { mode: string }) => { events.push(`recap:${req.mode}`); return 'run-1' }),
      clear: vi.fn(() => events.push('clear'))
    },
    settings,
    mode: 'meeting',
    isDustReady: () => false,
    setRecapSkipped: vi.fn(),
    setRecapSaveError: vi.fn(),
    generateColdCallCoaching: vi.fn()
  })
  const maybeFireRecap = evaluate<() => void>(callbackSource('maybeFireRecap'), context)
  return { context, events, save, spans, maybeFireRecap, tick: (ms: number) => { clock += ms } }
}

describe('M2-0430: the transcript is saved when the drain completes, never gated on the recap', () => {
  it('saves the transcript (empty recap) BEFORE requesting the recap, and does not wait for that save', async () => {
    const h = host({ localSummaryReady: true, providerReady: false })
    h.maybeFireRecap()
    // Ordering: transcript save first, then the recap request, in the same drain-complete turn.
    expect(h.events).toEqual(['save:100:1:""', 'recap:summary'])
    // The recap stream owns this meeting and will update the saved file when it ends.
    expect(h.context.liveRecapTargetRef.current).toMatchObject({ ownerId: '100', runId: 'run-1', file: null })
    // The save is still in flight: the recap was not gated on it either.
    expect(h.spans).toEqual([])
    h.tick(1_200)
    h.save.resolve('meetings/synthetic.md')
    await h.save.promise
    await Promise.resolve()
    expect(h.spans).toEqual([{ span: 'stop_to_transcript_saved', ms: 1_200 }])
  })

  it('the keyless path still saves once, with no recap request', async () => {
    const h = host({ localSummaryReady: false, providerReady: false, localFallbackReady: false })
    h.maybeFireRecap()
    expect(h.events).toEqual(['clear', 'save:100:1:""'])
  })

  it('does nothing until the drain has completed', () => {
    const h = host({ localSummaryReady: true })
    h.context.listen.listening = true
    h.maybeFireRecap()
    expect(h.events).toEqual([])
  })
})

describe('M2-0430: write-up spans are content-free and reported once per Stop', () => {
  it('reports nothing before a Stop, each span once after it, and nothing after reset', () => {
    const reports: WriteupSpanPayload[] = []
    let now = 0
    const spans = new WriteupSpans((p) => reports.push(p), () => now)
    spans.mark('stop_to_first_recap_token')
    expect(reports).toEqual([])
    now = 10
    spans.stop()
    now = 2_010
    spans.mark('stop_to_first_recap_token')
    spans.mark('stop_to_first_recap_token')
    now = 9_010
    spans.mark('stop_to_recap_done')
    expect(reports).toEqual([
      { span: 'stop_to_first_recap_token', ms: 2_000 },
      { span: 'stop_to_recap_done', ms: 9_000 }
    ])
    expect(reports.every((r) => Object.keys(r).sort().join() === 'ms,span')).toBe(true)
    spans.reset()
    spans.mark('stop_to_transcript_saved')
    expect(reports).toHaveLength(2)
  })
})
