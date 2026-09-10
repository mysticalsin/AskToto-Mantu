import { describe, expect, it, vi } from 'vitest'
import { OutlookDraftLifecycle, outlookDraftIntent } from './outlook-draft-lifecycle'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('Outlook draft lifecycle', () => {
  const intent = (meeting = 'meeting-a', body = 'Reviewed follow-up') =>
    outlookDraftIntent(meeting, { subject: 'Follow-up', body })

  it('guards the same intent synchronously and keeps a confirmed draft disabled', async () => {
    const lifecycle = new OutlookDraftLifecycle()
    const response = deferred<{ ok: boolean }>()
    const create = vi.fn(() => response.promise)
    const draft = intent('sync-guard')

    const first = lifecycle.start(draft, create)
    const duplicate = lifecycle.start(draft, create)

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    expect(create).toHaveBeenCalledOnce()
    response.resolve({ ok: true })
    await expect(first).resolves.toEqual({ current: true, selected: true, ok: true, error: null })
    expect(lifecycle.isConfirmed(draft)).toBe(true)
    expect(lifecycle.start(draft, create)).toBeNull()
  })

  it('lets an edited payload start deliberately without allowing the old result to overwrite it', async () => {
    const lifecycle = new OutlookDraftLifecycle()
    const oldResponse = deferred<{ ok: boolean }>()
    const newResponse = deferred<{ ok: boolean; error?: string }>()
    const oldIntent = intent('edited-payload', 'Old copy')
    const newIntent = intent('edited-payload', 'New copy')

    const oldAttempt = lifecycle.start(oldIntent, () => oldResponse.promise)!
    lifecycle.select(newIntent)
    const newAttempt = lifecycle.start(newIntent, () => newResponse.promise)!
    oldResponse.resolve({ ok: true })

    await expect(oldAttempt).resolves.toEqual({ current: false, selected: false, ok: true, error: null })
    expect(lifecycle.isConfirmed(oldIntent)).toBe(true)
    expect(lifecycle.isConfirmed(newIntent)).toBe(false)

    newResponse.resolve({ ok: false, error: 'Permission required.' })
    await expect(newAttempt).resolves.toEqual({ current: true, selected: true, ok: false, error: 'Permission required.' })
  })

  it('makes a completion stale when Review has moved to another meeting', async () => {
    const lifecycle = new OutlookDraftLifecycle()
    const response = deferred<{ ok: boolean }>()
    const oldIntent = intent('replacement-a')
    const replacementMeeting = intent('replacement-b')

    const oldAttempt = lifecycle.start(oldIntent, () => response.promise)!
    lifecycle.select(replacementMeeting)
    response.resolve({ ok: true })

    await expect(oldAttempt).resolves.toEqual({ current: false, selected: false, ok: true, error: null })
    expect(lifecycle.start(replacementMeeting, async () => ({ ok: false }))).not.toBeNull()
  })

  it('retains ambiguous guidance when the same intent is selected again before its request rejects', async () => {
    const lifecycle = new OutlookDraftLifecycle()
    const response = deferred<{ ok: boolean }>()
    const draftA = intent('return-to-a', 'Copy A')
    const draftB = intent('return-to-a', 'Copy B')

    const attemptA = lifecycle.start(draftA, () => response.promise)!
    lifecycle.select(draftB)
    lifecycle.select(draftA)
    response.reject(new Error('untrusted IPC rejection body'))

    await expect(attemptA).resolves.toMatchObject({
      current: false,
      selected: true,
      ok: false,
      error: 'Could not confirm whether Outlook created the draft. Check Drafts before trying again. Nothing was sent.'
    })
  })

  it('shares pending and confirmed status with a remounted Review without a second request', async () => {
    const firstView = new OutlookDraftLifecycle()
    const response = deferred<{ ok: boolean }>()
    const create = vi.fn(() => response.promise)
    const draft = intent('remounted-view')
    const firstAttempt = firstView.start(draft, create)!

    const remountedView = new OutlookDraftLifecycle()
    const changes = vi.fn()
    const unsubscribe = remountedView.subscribe(draft, changes)
    expect(remountedView.status(draft)).toEqual({ phase: 'saving', error: null })
    expect(remountedView.start(draft, create)).toBeNull()
    expect(create).toHaveBeenCalledOnce()

    response.resolve({ ok: true })
    await firstAttempt
    expect(changes).toHaveBeenCalled()
    expect(remountedView.status(draft)).toEqual({ phase: 'saved', error: null })
    expect(remountedView.isConfirmed(draft)).toBe(true)
    unsubscribe()
  })

  it('turns an IPC rejection into fixed guidance and releases the in-flight guard', async () => {
    const lifecycle = new OutlookDraftLifecycle()
    const draft = intent('ipc-rejection')
    const create = vi.fn(async () => {
      throw new Error('secret-token and provider response body')
    })

    const completion = await lifecycle.start(draft, create)

    expect(completion).toEqual({
      current: true,
      selected: true,
      ok: false,
      error: 'Could not confirm whether Outlook created the draft. Check Drafts before trying again. Nothing was sent.'
    })
    expect(completion?.error).not.toMatch(/secret-token|provider response body/i)
    expect(create).toHaveBeenCalledOnce()
    expect(lifecycle.start(draft, async () => ({ ok: false }))).not.toBeNull()
  })

  it('keys the exact normalized Graph payload together with its meeting', () => {
    const longBody = 'a'.repeat(20_001)
    const a = outlookDraftIntent('meeting-a', { subject: `  ${'s'.repeat(205)}  `, body: longBody })
    const sameGraphPayload = outlookDraftIntent('meeting-a', { subject: 's'.repeat(200), body: 'a'.repeat(20_000) })

    expect(a.payload).toEqual({ subject: 's'.repeat(200), body: 'a'.repeat(20_000) })
    expect(a.key).toBe(sameGraphPayload.key)
    expect(a.key).not.toBe(outlookDraftIntent('meeting-a', { ...sameGraphPayload.payload, body: 'edited' }).key)
    expect(a.key).not.toBe(outlookDraftIntent('meeting-b', sameGraphPayload.payload).key)
  })

  it('does not collapse distinct same-length payloads that collide under the former 32-bit key', () => {
    const a = outlookDraftIntent('sha-collision', { subject: 'Follow-up', body: 'rijudidmhizw' })
    const b = outlookDraftIntent('sha-collision', { subject: 'Follow-up', body: 'dcbsdcbqhspq' })

    expect(a.payload.body).toHaveLength(b.payload.body.length)
    expect(a.key).not.toBe(b.key)
    expect(a.key).toMatch(/^[a-f0-9]{64}$/)
    expect(b.key).toMatch(/^[a-f0-9]{64}$/)
  })
})
