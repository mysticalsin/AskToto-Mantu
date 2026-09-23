import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationCatalog } from './application-catalog'
import { parseApplicationIntent } from './application-intents'
import { ApplicationCommandSession } from './application-command-session'

vi.mock('node:child_process', () => { throw new Error('No process authority') })
vi.mock('child_process', () => { throw new Error('No process authority') })
vi.mock('electron', () => { throw new Error('No native authority') })
vi.mock('../shared/metis-command-parse', () => { throw new Error('No legacy grammar') })
vi.mock('./metis-command-runtime', () => { throw new Error('No legacy authority') })
vi.mock('./desktop-adapters', () => { throw new Error('No execution authority') })

const owner = { ownerId: 1, frameId: 'main-frame', isTopFrame: true }
const record = (name = 'Notes', overrides = {}) => ({
  displayName: name, aliases: [], kind: 'notes', available: true,
  native: { platform: 'darwin', bundlePath: `/Applications/${name}.app`, bundleId: `com.example.${name}`, fingerprint: 'private-build' },
  ...overrides
})
function fixture() {
  let time = 1000
  let records = [record()]
  const discovery = vi.fn(async () => records)
  const catalog = new ApplicationCatalog({ installationKey: new Uint8Array(32).fill(9), discovery: { discover: discovery }, now: () => time })
  const parser = vi.fn(parseApplicationIntent)
  const service = new ApplicationCommandSession({ catalog, parser, now: () => time })
  const session = service.start(owner)!
  return { service, session, parser, discovery, catalog,
    advance: (ms: number) => { time += ms }, records: (next: typeof records) => { records = next },
    submit: (text = 'open Notes', revision = 1) => service.submit(owner, { sessionId: session.sessionId, revision, text }) }
}
afterEach(() => vi.useRealTimers())

describe('main-owned application command session', () => {
  it.each([['open Notes', 'Open', 'R1'], ['focus Notes', 'Focus', 'R1'], ['quit Notes', 'Quit gracefully', 'R2'], ['close Notes', 'Quit gracefully', 'R2']])('proposes exact catalog selection for %s without exposing intent', async (text, actionLabel, risk) => {
    const f = fixture(), dto = await f.submit(text)
    expect(dto).toMatchObject({ phase: 'proposal', revision: 1, actionLabel, targetLabel: 'Notes', risk, expiresAt: 16000 })
    expect(Object.keys(dto).sort()).toEqual(['actionLabel', 'expiresAt', 'nonce', 'phase', 'proposalId', 'revision', 'risk', 'targetLabel'])
    expect(dto.proposalId).toMatch(/^[a-f0-9]{48}$/)
    expect(dto.nonce).toMatch(/^[a-f0-9]{48}$/)
    expect(f.discovery).toHaveBeenCalledTimes(2)
  })

  it('lists without making a target proposal or issuing confirmation authority', async () => {
    const f = fixture()
    expect(await f.submit('list apps')).toEqual({ phase: 'selection', revision: 1, actionLabel: 'List applications', targetLabel: 'Applications', risk: 'R0' })
  })

  it.each([
    ['open Unknown', 'missing'], ['open /Applications/Notes.app', 'malformed'], ['open com.apple.Notes', 'malformed'],
    ['open Notes\n', 'malformed'], ['open Notes\u202e', 'malformed'], ['open', 'unrecognized'],
    ['kill Notes', 'unrecognized'], ['please open Notes', 'unrecognized'], ['open Notes and quit Chrome', 'missing'],
    ['list; open Notes', 'unrecognized'], [' ', 'malformed'], ['a'.repeat(513), 'malformed'], ['😀'.repeat(257), 'malformed']
  ])('returns %s as non-action %s', async (text, phase) => {
    expect(await fixture().submit(text)).toEqual({ phase, revision: phase === 'malformed' && (text.trim() === '' || text.length > 512) ? 0 : 1 })
  })

  it.each([['ambiguous', [record(), record('Other', { aliases: ['Notes'] })]],
    ['restricted', [record('Notes', { kind: 'terminal' })]],
    ['unavailable', [record('Notes', { available: false })]]
  ] as const)('keeps %s distinct and never creates authority', async (phase, records) => {
    const f = fixture(); f.records([...records])
    expect(await f.submit()).toEqual({ phase, revision: 1 })
  })

  it('screens descriptors and exact keys before any parser or catalog call', async () => {
    const f = fixture(), getter = vi.fn(() => { throw new Error('Must not inspect') })
    const base = { sessionId: f.session.sessionId, revision: 1, text: 'open Notes' }
    const inputs: unknown[] = [null, [], Object.create(base), Object.assign(Object.create(null), base), { ...base, action: 'apps.open' },
      { ...base, [Symbol('extra')]: 1 }, Object.defineProperty({ ...base }, 'hidden', { value: 1 }),
      JSON.parse(`{"sessionId":"${base.sessionId}","revision":1,"text":"open Notes","__proto__":{}}`)]
    for (const key of ['text', 'revision', 'sessionId', 'then', 'catch']) inputs.push(Object.defineProperty({ ...base }, key, { enumerable: true, get: getter }))
    for (const key of ['text', 'revision', 'sessionId']) inputs.push({ ...base, [key]: Object.defineProperty({}, 'then', { get: getter }) })
    for (const input of inputs) expect((await f.service.submit(owner, input)).phase).toBe('malformed')
    expect(getter).not.toHaveBeenCalled(); expect(f.parser).not.toHaveBeenCalled(); expect(f.discovery).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects invalid revision %s before parsing', async revision => {
    const f = fixture()
    expect((await f.service.submit(owner, { sessionId: f.session.sessionId, revision, text: 'open Notes' })).phase).toBe('malformed')
    expect(f.parser).not.toHaveBeenCalled()
  })

  it.each([{ ...owner, ownerId: 2 }, { ...owner, frameId: 'other' }, { ...owner, isTopFrame: false }])('rejects a mismatched caller binding %j without leaking the proposal', async caller => {
    const f = fixture(); await f.submit()
    expect(await f.service.submit(caller, { sessionId: f.session.sessionId, revision: 2, text: 'open Notes' })).toEqual({ phase: 'unauthorized', revision: 0 })
    expect(f.service.state(caller)).toEqual({ phase: 'unauthorized', revision: 0 })
    expect(f.service.state(owner).phase).toBe('proposal')
  })

  it('rejects wrong session, replay and lower revision without overwriting a proposal', async () => {
    const f = fixture(), dto = await f.submit()
    expect((await f.service.submit(owner, { sessionId: '0'.repeat(48), revision: 2, text: 'open Notes' })).phase).toBe('unauthorized')
    f.advance(300)
    expect((await f.submit('quit Notes', 1)).phase).toBe('stale-revision')
    expect(f.service.state(owner)).toEqual(dto)
    expect(f.discovery).toHaveBeenCalledTimes(2)
  })

  it('revokes the previous proposal on a newer accepted non-action revision', async () => {
    const f = fixture(), old = await f.submit(); f.advance(300)
    expect((await f.submit('nonsense', 2)).phase).toBe('unrecognized')
    expect(f.service.cancel(owner, old.proposalId!, old.nonce!)).toBe(false)
  })

  it('creates unpredictable unique pairs and consumes cancellation exactly once', async () => {
    const f = fixture(), first = await f.submit()
    expect(f.service.cancel(owner, first.proposalId!, 'wrong')).toBe(false)
    expect(f.service.cancel({ ...owner, isTopFrame: false }, first.proposalId!, first.nonce!)).toBe(false)
    expect(f.service.cancel(owner, first.proposalId!, first.nonce!)).toBe(true)
    expect(f.service.cancel(owner, first.proposalId!, first.nonce!)).toBe(false)
    expect((await f.submit('open Notes', 2)).phase).toBe('cancelled')
    const next = f.service.start(owner)!
    expect(next.sessionId).not.toBe(f.session.sessionId)
    const second = await f.service.submit(owner, { sessionId: next.sessionId, revision: 1, text: 'open Notes' })
    expect(second.proposalId).not.toBe(first.proposalId); expect(second.nonce).not.toBe(first.nonce)
  })

  it.each(['stop', 'rendererReplaced', 'windowReplaced', 'shutdown', 'reserveMeetingCapture'] as const)('%s revokes pending catalog work and the session', async hook => {
    const f = fixture()
    let release!: (value: Awaited<ReturnType<typeof f.catalog.resolve>>) => void
    const original = await f.catalog.resolve('Notes')
    vi.spyOn(f.catalog, 'resolve').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = f.submit()
    if (hook === 'stop') f.service.stop(owner)
    else if (hook === 'reserveMeetingCapture') f.service.reserveMeetingCapture(true)
    else if (hook === 'shutdown') f.service.shutdown()
    else f.service[hook](owner.ownerId)
    release(original)
    expect((await pending).phase).not.toBe('proposal')
    expect((await f.submit('open Notes', 2)).phase).not.toBe('proposal')
    if (hook === 'shutdown' || hook === 'reserveMeetingCapture') expect(f.service.start(owner)).toBeNull()
  })

  it('does not let an unrelated window stop the owner session and can recover after meeting capture', async () => {
    const f = fixture(); const dto = await f.submit()
    f.service.rendererReplaced(999); f.service.windowReplaced(999); f.service.stop({ ...owner, ownerId: 9 })
    expect(f.service.state(owner)).toEqual(dto)
    f.service.reserveMeetingCapture(true); f.service.reserveMeetingCapture(false)
    expect(f.service.start(owner)).not.toBeNull()
  })

  it('replaces sessions and ignores an older in-flight response', async () => {
    const f = fixture(), old = await f.submit(), next = f.service.start(owner)!
    expect(f.service.cancel(owner, old.proposalId!, old.nonce!)).toBe(false)
    expect((await f.submit()).phase).toBe('unauthorized')
    expect((await f.service.submit(owner, { sessionId: next.sessionId, revision: 1, text: 'open Notes' })).phase).toBe('proposal')
  })

  it.each([['session', 30000], ['proposal', 15000]] as const)('expires %s at the exact boundary and refuses cancellation', async (kind, elapsed) => {
    const f = fixture(); const dto = kind === 'proposal' ? await f.submit() : undefined
    f.advance(elapsed)
    expect(f.service.state(owner)).toEqual({ phase: 'expired', revision: dto ? 1 : 0 })
    expect((await f.submit('open Notes', 2)).phase).toBe('expired')
    if (dto) expect(f.service.cancel(owner, dto.proposalId!, dto.nonce!)).toBe(false)
  })

  it('fails closed for backward or invalid clock readings', async () => {
    const f = fixture(); await f.submit(); f.advance(-1)
    expect(f.service.state(owner).phase).toBe('expired')
    const g = fixture(); g.advance(NaN)
    expect((await g.submit()).phase).toBe('expired')
  })

  it('revokes on rapid submissions and on the ninth session attempt', async () => {
    const f = fixture(); await f.submit()
    expect((await f.submit('open Notes', 2)).phase).toBe('rate-limited')
    f.advance(300); expect((await f.submit('open Notes', 3)).phase).toBe('rate-limited')
    const g = fixture()
    for (let revision = 1; revision <= 8; revision++) { expect((await g.submit('unknown', revision)).phase).toBe('unrecognized'); g.advance(300) }
    expect((await g.submit('open Notes', 9)).phase).toBe('rate-limited')
  })

  it('never publishes a stale catalog selection', async () => {
    const f = fixture()
    f.discovery.mockImplementationOnce(async () => [record()]).mockImplementationOnce(async () => [record('Notes', { aliases: ['Changed'] })])
    expect(await f.submit()).toEqual({ phase: 'stale-catalog', revision: 1 })
  })

  it.each([['missing', []], ['unavailable', [record('Notes', { available: false })]],
    ['restricted', [record('Notes', { kind: 'terminal' })]]
  ] as const)('reports %s when the selected application changes before proposal', async (phase, records) => {
    const f = fixture()
    f.discovery.mockImplementationOnce(async () => [record()]).mockImplementationOnce(async () => [...records])
    expect(await f.submit()).toEqual({ phase, revision: 1 })
  })

  it('revokes rather than staying usable when a failed dependency crosses its deadline', async () => {
    const f = fixture()
    f.discovery.mockImplementationOnce(async () => { f.advance(2000); throw new Error('private dependency error') })
    expect(await f.submit()).toEqual({ phase: 'deadline', revision: 1 })
    expect((await f.submit('open Notes', 2)).phase).toBe('deadline')
  })

  it.each([{ ...owner, ownerId: 0 }, { ...owner, ownerId: 1.5 }, { ...owner, frameId: '' },
    { ...owner, frameId: 'x'.repeat(257) }, { ...owner, isTopFrame: false }])('does not create a session for an invalid main binding %j', binding => {
    expect(fixture().service.start(binding)).toBeNull()
  })

  it('copies the main binding and does not grant access after caller mutation', async () => {
    const f = fixture(), binding = { ...owner }
    const session = f.service.start(binding)!
    binding.ownerId = 2; binding.frameId = 'changed'
    expect((await f.service.submit(binding, { sessionId: session.sessionId, revision: 1, text: 'open Notes' })).phase).toBe('unauthorized')
    expect((await f.service.submit(owner, { sessionId: session.sessionId, revision: 1, text: 'open Notes' })).phase).toBe('proposal')
  })

  it('contains parser failure and reflection failure without invoking unsafe getters', async () => {
    const f = fixture()
    const revocable = Proxy.revocable({}, {}); revocable.revoke()
    expect((await f.service.submit(owner, revocable.proxy)).phase).toBe('malformed')
    f.parser.mockImplementationOnce(() => { throw new Error('private text') })
    expect(await f.submit()).toEqual({ phase: 'unavailable', revision: 1 })
    expect(f.discovery).not.toHaveBeenCalled()
  })

  it('contains an unavailable clock without exposing its error', () => {
    const f = fixture()
    const service = new ApplicationCommandSession({ catalog: f.catalog, now: () => { throw new Error('private clock failure') } })
    expect(service.start(owner)).toBeNull()
    expect(service.state(owner)).toEqual({ phase: 'unauthorized', revision: 0 })
  })

  it('refuses a parser that changes the selected operation or target binding', async () => {
    const f = fixture()
    f.parser.mockImplementation(input => {
      const parsed = parseApplicationIntent(input)
      if (!parsed.success || parsed.data.operation === 'apps.list') return parsed
      return parseApplicationIntent({ ...parsed.data, operation: 'apps.quit', mode: 'graceful' })
    })
    expect(await f.submit()).toEqual({ phase: 'malformed', revision: 1 })
  })

  it.each(['applicationId', 'revision', 'digest'] as const)('rejects an injected parser changing %s', async field => {
    const f = fixture()
    f.parser.mockImplementation(input => {
      const parsed = parseApplicationIntent(input)
      if (!parsed.success || parsed.data.operation === 'apps.list') return parsed
      return parseApplicationIntent({ ...parsed.data,
        applicationId: field === 'applicationId' ? `app_${'0'.repeat(64)}` : parsed.data.applicationId,
        candidateSet: { revision: field === 'revision' ? 99 : parsed.data.candidateSet.revision,
          digest: field === 'digest' ? '0'.repeat(64) : parsed.data.candidateSet.digest } })
    })
    expect(await f.submit()).toEqual({ phase: 'malformed', revision: 1 })
  })

  it('rejects a parser that substitutes a different display query before catalog access', async () => {
    const f = fixture()
    f.parser.mockReturnValueOnce({ success: true, data: { operation: 'apps.list', query: 'Other' } })
    expect(await f.submit()).toEqual({ phase: 'malformed', revision: 1 })
    expect(f.discovery).not.toHaveBeenCalled()
  })

  it.each(['stop', 'deadline'] as const)('revokes while fresh catalog revalidation is pending: %s', async mode => {
    vi.useFakeTimers()
    const f = fixture()
    let started!: () => void
    const called = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(f.catalog, 'revalidate').mockImplementation(() => { started(); return new Promise(() => {}) })
    const pending = f.submit(); await called
    if (mode === 'stop') f.service.stop(owner)
    else await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ phase: mode === 'stop' ? 'stopped' : 'deadline', revision: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('permits the exact minimum interval and positive safe-integer revision ceiling', async () => {
    const f = fixture(); await f.submit('unrecognized')
    f.advance(250)
    expect(await f.submit('focus Notes', Number.MAX_SAFE_INTEGER)).toMatchObject({ phase: 'proposal', revision: Number.MAX_SAFE_INTEGER })
    expect((await f.submit('open Notes', 2)).phase).toBe('stale-revision')
  })

  it('limits hung discovery and ignores its late result', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.discovery.mockImplementationOnce(() => new Promise(() => {}))
    const pending = f.submit(); await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ phase: 'deadline', revision: 1 })
    expect((await f.submit('open Notes', 2)).phase).toBe('deadline')
  })

  it('revokes at wall-clock expiry without requiring a state read', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.submit()
    // The injected clock remains fixed. The expiry timer still revokes access.
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.service.state(owner)).toEqual({ phase: 'expired', revision: 1 })
  })

  it('releases pending callers immediately when stopped even if discovery never returns', async () => {
    const f = fixture()
    f.discovery.mockImplementationOnce(() => new Promise(() => {}))
    const pending = f.submit(); f.service.stop(owner)
    expect(await pending).toEqual({ phase: 'stopped', revision: 1 })
  })

  it('cannot let an older in-flight selection replace the latest revision', async () => {
    const f = fixture(), resolved = await f.catalog.resolve('Notes')
    let release!: (value: typeof resolved) => void
    vi.spyOn(f.catalog, 'resolve').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const older = f.submit(); f.advance(300)
    const newer = await f.submit('quit Notes', 2)
    release(resolved)
    expect(await older).toEqual({ phase: 'replaced', revision: 1 })
    expect(newer).toMatchObject({ phase: 'proposal', revision: 2, actionLabel: 'Quit gracefully' })
    expect(f.service.state(owner)).toEqual(newer)
  })

  it('checks the clock deadline after a resolved dependency and clears cancelled timers', async () => {
    vi.useFakeTimers()
    const f = fixture(), original = f.catalog.resolve.bind(f.catalog)
    vi.spyOn(f.catalog, 'resolve').mockImplementation(async query => { const resolved = await original(query); f.advance(2000); return resolved })
    expect(await f.submit()).toEqual({ phase: 'deadline', revision: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts exactly 512 code units and still restricts app queries to 120 characters', async () => {
    const f = fixture()
    expect((await f.submit('open ' + 'N'.repeat(507))).phase).toBe('malformed')
    expect(f.parser).toHaveBeenCalledTimes(1)
    expect(f.discovery).not.toHaveBeenCalled()
  })

  it('never accesses process, legacy adapters, or network while proposing and cancelling', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('No network authority') })
    try {
      const f = fixture(), dto = await f.submit()
      expect(dto.phase).toBe('proposal')
      f.service.cancel(owner, dto.proposalId!, dto.nonce!)
      expect(network).not.toHaveBeenCalled()
    } finally { network.mockRestore() }
  })

  it('sanitizes dependency errors and keeps all private state out of reflection and JSON', async () => {
    const f = fixture(), secret = 'SECRET_SUBMITTED_TEXT'
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dto = await f.submit('open Notes')
    expect(JSON.stringify(f.service)).toBe('{}'); expect(Reflect.ownKeys(f.service)).toEqual([])
    expect(JSON.stringify(dto)).not.toMatch(/app_|candidateSet|digest|intent|native|fingerprint|private-build|Applications\/|open Notes/)
    f.advance(300); f.discovery.mockRejectedValueOnce(new Error(secret))
    expect(await f.submit('focus Notes', 2)).toEqual({ phase: 'unavailable', revision: 2 })
    expect(log).not.toHaveBeenCalled(); log.mockRestore()
    expect(Object.isFrozen(dto)).toBe(true)
  })
})
