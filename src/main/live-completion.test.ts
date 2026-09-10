/**
 * Execute the real attempt-local handler region, not a copy of its branching logic. Importing
 * index.ts boots Electron, discovers profiles and registers devices, so AST extraction isolates the
 * contiguous region from its per-attempt state through createStream/handle registration. Transport,
 * persistence and IPC are replaced at their boundaries; ThinkStripper, retry classification and the
 * hedge state machine stay real. No application profile, native runtime or network is loaded.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HedgeRace, type HedgeLeg } from './llm/hedge'
import { ThinkStripper } from './llm/think-strip'
import { classifyExhaustion } from './llm/exhaustion'
import { isProxyOperatorFault, isTransient, nextBackoff, stripProxyFaultMarker } from './llm/retry'
import type { StreamHandle, StreamHandlers, StreamOptions } from './llm/shared'

const source = ts.createSourceFile('index.ts', readFileSync(join(__dirname, 'index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
let attemptBody: ts.Block | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'attempt' &&
      node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body) &&
      node.initializer.body.getText(source).includes('noteQualifyingUse(req.mode')) {
    if (attemptBody) throw new Error('Expected one production live attempt')
    attemptBody = node.initializer.body
  }
  ts.forEachChild(node, visit)
}
visit(source)
if (!attemptBody) throw new Error('Production live attempt not found')
const statements = attemptBody.statements
const first = statements.findIndex((s) => ts.isVariableStatement(s) &&
  s.declarationList.declarations.some((d) => d.name.getText(source) === 'startedAt'))
if (first < 0) throw new Error('Production attempt state boundary not found')
const region = statements.slice(first).map((s) => s.getText(source)).join('\n')
const js = ts.transpileModule(region, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const id = 'synthetic-live-completion'
const usage = { inputTokens: 11, outputTokens: 7, cacheRead: 5 }

function setup(options: {
  mode?: string
  provider?: string
  race?: { gate: HedgeRace; leg: HedgeLeg }
  streams?: Map<string, StreamHandle>
  failoverAvailable?: boolean
  retryCount?: number
} = {}) {
  const send = vi.fn(), audit = vi.fn(), record = vi.fn(), qualifying = vi.fn()
  const streams = options.streams ?? new Map<string, StreamHandle>()
  const handle = { abort: vi.fn() }
  const failover = vi.fn(() => options.failoverAvailable ?? false)
  const retry = vi.fn()
  let handlers: StreamHandlers | undefined
  const provider = options.provider ?? 'openai'
  const scope = {
    provider, model: 'synthetic-model', tier: 'base', race: options.race,
    attempted: [], retryCount: options.retryCount ?? 0, streams,
    req: { id, mode: options.mode ?? 'recap', prompt: 'synthetic question', transcript: 'synthetic transcript', history: [] },
    s: { mode: 'meeting', contextDocs: {}, resilience: { preferFreeOnExhaustion: true } },
    def: { kind: provider === 'claude-cli' ? 'cli' : 'openai', label: 'Synthetic provider' },
    key: 'synthetic-no-credential', viaOperator: false, operatorTransport: undefined,
    baseURL: undefined, idleMs: 1000, screenGrounded: false,
    ThinkStripper, isTransient, nextBackoff, classifyExhaustion,
    isProxyOperatorFault, stripProxyFaultMarker,
    setTimeout, clearTimeout, MAX_TRANSIENT_RETRIES: 3, MAX_ASK_RETRY_WAIT_MS: 12_000,
    win: { webContents: { send } },
    IPC: { streamDelta: 'delta', streamError: 'error', streamDone: 'done', streamMeta: 'meta' },
    createStream: (opts: StreamOptions) => { handlers = opts.handlers; return handle },
    auditLog: audit, recordOperatorAsk: record, noteQualifyingUse: qualifying,
    recordSuccess: vi.fn(), recordRateLimited: vi.fn(), recordExhausted: vi.fn(), recordAuthFailure: vi.fn(),
    isDustAuthError: () => false, isAuthFailure: () => false, retireCli: vi.fn(),
    mainLog: { warn: vi.fn() },
    pickFailover: () => options.failoverAvailable ? 'anthropic' : null, failover, attempt: retry,
    formatResetPhrase: () => 'later',
    buildSystemParts: () => ({ cachedPrefix: 'synthetic system', volatile: '' }),
    isOpenAICloudCacheEligible: () => false, makePromptCacheKey: () => '', skillLockHashForMode: () => '',
    makeRefreshDustAuth: () => undefined, reasoningEffortFor: () => undefined,
    loadVerifiedSkill: () => ({ id: 'synthetic', version: '1' }),
    isBuiltinConversationMode: () => true, classifyQuestionType: () => 'other'
  }
  new Function(...Object.keys(scope), js)(...Object.values(scope))
  if (!handlers) throw new Error('Actual attempt did not register stream handlers')
  return {
    handlers: handlers as StreamHandlers, send, audit, record, qualifying, streams, handle, failover, retry,
    warnings: scope.mainLog.warn,
    events: (kind: string) => send.mock.calls.filter(([event]) => event === kind),
    text: () => send.mock.calls.filter(([event]) => event === 'delta').map(([, data]) => data.text).join('')
  }
}
type Fixture = ReturnType<typeof setup>
function expectFailed(f: Fixture, text: string): void {
  expect(f.text()).toBe(text)
  expect(f.events('error')).toHaveLength(1)
  expect(f.events('done')).toHaveLength(0)
  expect(f.audit.mock.calls.some(([event, detail]) => event === 'provider.request' && detail.phase === 'done')).toBe(false)
  expect(f.record).not.toHaveBeenCalled()
  expect(f.qualifying).not.toHaveBeenCalled()
  expect(f.streams.has(id)).toBe(false)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('actual live completion outcomes', () => {
  it.each(['recap', 'summary', 'answer', 'vision'])('does not report incomplete %s as success at any visible-text threshold', (mode) => {
    for (const length of [1, 199, 200, 260]) {
      const f = setup({ mode, failoverAvailable: true })
      const partial = 'x'.repeat(length)
      f.handlers.onDelta(partial)
      f.handlers.onDone(usage, { status: 'incomplete', reason: 'length' })
      expectFailed(f, partial)
      expect(f.failover).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(f.retry).not.toHaveBeenCalled()
    }
  })
  it.each(['max_tokens', 'unexpected_eof', 'secret-like-provider-reason-not-for-feedback'])('safely rejects incomplete reason %s', (reason) => {
    const f = setup()
    f.handlers.onDelta('partial answer')
    f.handlers.onDone(usage, { status: 'incomplete', reason })
    expectFailed(f, 'partial answer')
    expect(JSON.stringify([f.send.mock.calls, f.audit.mock.calls, f.warnings.mock.calls])).not.toContain(reason)
  })
  it.each([
    ['dust', 'Dust stream ended before an agent success event.'],
    ['openai', 'Connection error.'],
    ['claude-cli', 'Timed out — no response from the agent.']
  ])('preserves >200 partial characters without salvaging %s errors as success', (provider, message) => {
    const f = setup({ provider, failoverAvailable: true })
    f.handlers.onDelta('p'.repeat(250))
    f.handlers.onError(message)
    expectFailed(f, 'p'.repeat(250))
    expect(f.audit).toHaveBeenCalledWith('provider.failed', { provider, gotToken: true, retry: 0 })
    expect(f.failover).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(f.retry).not.toHaveBeenCalled()
  })
  it.each(['recap', 'summary', 'answer', 'vision'])('keeps verified complete %s successful with usage', (mode) => {
    const f = setup({ mode })
    f.handlers.onDelta('complete answer')
    f.handlers.onDone(usage, { status: 'complete', reason: 'stop' })
    expect(f.events('error')).toHaveLength(0)
    expect(f.events('done')).toEqual([['done', { id, ...usage }]])
    expect(f.qualifying).toHaveBeenCalledTimes(1)
    expect(f.record).toHaveBeenCalledTimes(['answer', 'vision'].includes(mode) ? 1 : 0)
    expect(f.streams.has(id)).toBe(false)
  })
  it('deliberately preserves legacy onDone without metadata, not a verified-completeness claim', () => {
    const f = setup({ provider: 'claude-cli' })
    f.handlers.onDelta('legacy answer')
    f.handlers.onDone({})
    expect(f.events('done')).toHaveLength(1)
    expect(f.qualifying).toHaveBeenCalledTimes(1)
  })
  it('flushes a held visible tail before incomplete routing can start a second provider', () => {
    const f = setup({ failoverAvailable: true })
    f.handlers.onDelta('<')
    expect(f.text()).toBe('')
    f.handlers.onDone({}, { status: 'incomplete', reason: 'length' })
    expectFailed(f, '<')
    expect(f.failover).not.toHaveBeenCalled()
  })
  it('allows existing cloud failover before any visible incomplete output', () => {
    const f = setup({ failoverAvailable: true })
    f.handlers.onDone({}, { status: 'incomplete', reason: 'length' })
    expect(f.failover).toHaveBeenCalledTimes(1)
    const [tried, preferFree, race] = f.failover.mock.calls[0] as unknown as [string[], boolean | undefined, unknown]
    expect(tried).toEqual(['openai'])
    expect(!!preferFree).toBe(false)
    expect(race).toBeUndefined()
    expect(f.events('done')).toHaveLength(0)
    expect(f.events('error')).toHaveLength(0)
    expect(f.qualifying).not.toHaveBeenCalled()
  })
  it.each(['openai', 'local'])('surfaces empty incomplete %s when no permitted backup can answer', (provider) => {
    const f = setup({ provider, failoverAvailable: provider === 'local' })
    f.handlers.onDone({}, { status: 'incomplete', reason: 'unexpected_eof' })
    expectFailed(f, '')
    if (provider === 'local') expect(f.failover).not.toHaveBeenCalled()
  })
  it.each(['openai', 'local'])('preserves the complete-but-empty safeguard for %s', (provider) => {
    const f = setup({ provider })
    f.handlers.onDone({}, { status: 'complete', reason: 'stop' })
    expectFailed(f, '')
  })
  it('keeps local transient retry on-device and its backoff cancellable', () => {
    const f = setup({ provider: 'local', failoverAvailable: true })
    f.handlers.onError('Connection error.')
    expect(f.failover).not.toHaveBeenCalled()
    expect(f.events('done')).toHaveLength(0)
    f.streams.get(id)!.abort()
    vi.runAllTimers()
    expect(f.retry).not.toHaveBeenCalled()
  })
  it('retains the existing bounded same-cloud-provider retry before visible output', () => {
    const f = setup({ failoverAvailable: true })
    f.handlers.onError('Connection error.')
    vi.runAllTimers()
    expect(f.retry).toHaveBeenCalledWith('openai', [], 1, undefined)
    expect(f.failover).not.toHaveBeenCalled()
    expect(f.events('done')).toHaveLength(0)
  })
})

describe('actual live completion with real hedge ownership', () => {
  it('ignores an incomplete losing leg without surrendering the combined abort handle', () => {
    const gate = new HedgeRace()
    const combined = { abort: vi.fn() }
    const streams = new Map([[id, combined]])
    gate.declareWinner('primary')
    const f = setup({ race: { gate, leg: 'hedge' }, streams })
    f.handlers.onDelta('must not appear')
    f.handlers.onDone({}, { status: 'incomplete', reason: 'length' })
    expect(f.handle.abort).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.qualifying).not.toHaveBeenCalled()
    expect(streams.get(id)).toBe(combined)
  })
  it('waits for a viable backup after an empty incomplete primary and then accepts its success', () => {
    const gate = new HedgeRace()
    const streams = new Map([[id, { abort: vi.fn() }]])
    const primary = setup({ race: { gate, leg: 'primary' }, streams })
    let backup: Fixture | undefined
    gate.setHedgeStarter(() => { backup = setup({ race: { gate, leg: 'hedge' }, streams }) })
    primary.handlers.onDone({}, { status: 'incomplete', reason: 'length' })
    expect(primary.events('done')).toHaveLength(0)
    expect(primary.events('error')).toHaveLength(0)
    expect(streams.has(id)).toBe(true)
    expect(backup).toBeDefined()
    backup!.handlers.onDelta('backup answer')
    backup!.handlers.onDone({}, { status: 'complete', reason: 'stop' })
    expect(backup!.events('done')).toHaveLength(1)
    expect(streams.has(id)).toBe(false)
  })
  it('terminates an incomplete winner after 250 characters without reviving the loser', () => {
    const gate = new HedgeRace()
    const streams = new Map([[id, { abort: vi.fn() }]])
    const primary = setup({ race: { gate, leg: 'primary' }, streams })
    const backup = setup({ race: { gate, leg: 'hedge' }, streams })
    primary.handlers.onDelta('w'.repeat(250))
    expect(backup.handle.abort).toHaveBeenCalledTimes(1)
    primary.handlers.onDone({}, { status: 'incomplete', reason: 'length' })
    expectFailed(primary, 'w'.repeat(250))
    backup.handlers.onDelta('late loser')
    backup.handlers.onDone({}, { status: 'complete', reason: 'stop' })
    expect(backup.send).not.toHaveBeenCalled()
    expect(backup.qualifying).not.toHaveBeenCalled()
  })
})
