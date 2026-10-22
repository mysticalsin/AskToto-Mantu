import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'
import { areBrainContextRecordsCurrent, areBrainContextSourcesCurrent } from './context'
import { createBrainContextEnvelope, unavailableBrainContextEnvelope } from './context-envelope'
import type { BrainContextOwner } from './context-envelope'
import { createBrainContextDispatch, holdForCancel } from './context-dispatch'

vi.mock('electron')
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  areBrainContextRecordsCurrent: vi.fn(),
  areBrainContextSourcesCurrent: vi.fn()
}))

const records = vi.mocked(areBrainContextRecordsCurrent)
const sources = vi.mocked(areBrainContextSourcesCurrent)
const owner: BrainContextOwner = {
  authSessionGeneration: 1,
  contextRevision: 1,
  brainRevision: 1,
  profileKey: 'a'.repeat(64)
}
const readyEnvelope = () =>
  createBrainContextEnvelope(owner, {
    block: 'Maria promised pricing.',
    matched: true,
    sourceReferences: [],
    sourceReferencesComplete: true,
    recordFingerprints: [{ kind: 'person', slug: 'maria-silva', digest: 'b'.repeat(64) }]
  })

function setup(currentOwner: () => BrainContextOwner = () => owner) {
  const streams = new Map<string, { abort: () => void }>()
  const req: { id: string; brainContext?: string } = { id: 'ask-1' }
  const onError = vi.fn()
  const dispatch = createBrainContextDispatch({
    getSettings: () => ({}) as Settings,
    currentOwner,
    req,
    streams,
    onError
  })
  return { streams, req, onError, dispatch }
}

/** A promise a test settles by hand, so a proof can be held in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  records.mockReset()
  sources.mockReset()
})

describe('brain context dispatch', () => {
  it('dispatches synchronously when there is no ready envelope, without touching the files', () => {
    const { dispatch, req, streams } = setup()
    req.brainContext = 'stale from before'
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    expect(run).toHaveBeenCalledOnce()
    expect(req.brainContext).toBeUndefined()
    expect(streams.size).toBe(0)
    dispatch.set(unavailableBrainContextEnvelope(owner))
    dispatch.dispatch(undefined, run)
    expect(run).toHaveBeenCalledTimes(2)
    expect(records).not.toHaveBeenCalled()
  })

  it('re-proves a ready envelope before dispatch and supplies the block only when the files are current', async () => {
    const { dispatch, req } = setup()
    dispatch.set(readyEnvelope())
    records.mockResolvedValue(true)
    sources.mockResolvedValue(true)
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(req.brainContext).toBe('Maria promised pricing.')
  })

  it.each([
    ['records changed', false, true],
    ['sources changed', true, false]
  ])('fails closed when %s', async (_name, recordsOk, sourcesOk) => {
    const { dispatch, req } = setup()
    dispatch.set(readyEnvelope())
    records.mockResolvedValue(recordsOk)
    sources.mockResolvedValue(sourcesOk)
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(req.brainContext).toBeUndefined()
    // The envelope is now stale for every later attempt of the same ask.
    records.mockResolvedValue(true)
    sources.mockResolvedValue(true)
    const again = vi.fn()
    dispatch.dispatch(undefined, again)
    expect(again).toHaveBeenCalledOnce()
    expect(req.brainContext).toBeUndefined()
  })

  it('fails closed when a proof rejects', async () => {
    const { dispatch, req } = setup()
    dispatch.set(readyEnvelope())
    records.mockRejectedValue(new Error('read failed'))
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(req.brainContext).toBeUndefined()
  })

  it('compares the owner after the proofs, so a boundary change during the proof withholds the block', async () => {
    let current = owner
    const { dispatch, req } = setup(() => current)
    dispatch.set(readyEnvelope())
    const proof = deferred<boolean>()
    records.mockReturnValue(proof.promise)
    sources.mockResolvedValue(true)
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    current = { ...owner, authSessionGeneration: 2 }
    proof.resolve(true)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(req.brainContext).toBeUndefined()
  })

  it('does not dispatch when the ask is cancelled while the proof is in flight', async () => {
    const { dispatch, streams } = setup()
    dispatch.set(readyEnvelope())
    const proof = deferred<boolean>()
    records.mockReturnValue(proof.promise)
    sources.mockResolvedValue(true)
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    // This is what the askCancel handler does with the registered entry.
    streams.get('ask-1')?.abort()
    streams.delete('ask-1')
    proof.resolve(true)
    await proof.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
    expect(streams.size).toBe(0)
  })

  it('under a hedge race the hold joins the race cleanups and a cancel stops dispatch', async () => {
    const { dispatch, streams } = setup()
    dispatch.set(readyEnvelope())
    const proof = deferred<boolean>()
    records.mockReturnValue(proof.promise)
    sources.mockResolvedValue(true)
    const cleanups: (() => void)[] = []
    const run = vi.fn()
    dispatch.dispatch({ addCleanup: (fn) => cleanups.push(fn) }, run)
    expect(streams.size).toBe(0)
    expect(cleanups).toHaveLength(1)
    cleanups.forEach((fn) => fn())
    proof.resolve(true)
    await proof.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a dispatch that throws after an async proof through onError', async () => {
    const { dispatch, onError } = setup()
    dispatch.set(readyEnvelope())
    records.mockResolvedValue(true)
    sources.mockResolvedValue(true)
    const failure = new Error('dispatch failed')
    dispatch.dispatch(undefined, () => {
      throw failure
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
  })
})

describe('holdForCancel', () => {
  it('replaces and then removes the stream entry, reporting an abort made meanwhile', () => {
    const streams = new Map<string, { abort: () => void }>()
    const hold = holdForCancel(streams, 'ask-1')
    expect(streams.has('ask-1')).toBe(true)
    streams.get('ask-1')!.abort()
    streams.delete('ask-1')
    expect(hold.release()).toBe(true)
    const quiet = holdForCancel(streams, 'ask-2')
    expect(quiet.release()).toBe(false)
    expect(streams.size).toBe(0)
  })
})

describe('conversation-context gate (G13)', () => {
  function gated(message: () => string | null) {
    const streams = new Map<string, { abort: () => void }>()
    const req: { id: string; brainContext?: string } = { id: 'ask-1' }
    const onRefused = vi.fn()
    const dispatch = createBrainContextDispatch({
      getSettings: () => ({}) as Settings,
      currentOwner: () => owner,
      req,
      streams,
      onError: vi.fn(),
      gate: { refusal: message },
      onRefused
    })
    return { streams, dispatch, onRefused }
  }

  it('dispatches while the gate has no objection', () => {
    const { dispatch, onRefused } = gated(() => null)
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('refuses at dispatch, aborts the ask, and says so once however many legs try', () => {
    const { dispatch, onRefused, streams } = gated(() => 'The conversation changed while this answer was starting.')
    const abort = vi.fn()
    streams.set('ask-1', { abort })
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    dispatch.dispatch(undefined, run)
    expect(run).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    expect(streams.has('ask-1')).toBe(false)
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onRefused).toHaveBeenCalledWith('The conversation changed while this answer was starting.')
  })

  it('re-checks after an async proof settles, so a snapshot that went stale meanwhile is not dispatched', async () => {
    let stale = false
    const { dispatch, onRefused } = gated(() => (stale ? 'stale' : null))
    dispatch.set(readyEnvelope())
    const proof = deferred<boolean>()
    records.mockReturnValue(proof.promise)
    sources.mockResolvedValue(true)
    const run = vi.fn()
    dispatch.dispatch(undefined, run)
    stale = true
    proof.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
    expect(onRefused).toHaveBeenCalledWith('stale')
  })
})
