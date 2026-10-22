import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ownerCommand } from '@shared/context-authority'
import { createVoiceRouter, VOICE_CLASSIFY_DEADLINE_MS } from './voice-router'

const ownerSpeech = (text: string) => ownerCommand('user-spoken-by-owner', text)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('voice router: the grammar decides first', () => {
  it('never calls the classifier for something the grammar recognised', async () => {
    const classify = vi.fn()
    const router = createVoiceRouter({ providerReady: () => true, classify })
    expect(await router.route(ownerSpeech('open notes'))).toEqual({
      kind: 'action',
      request: { id: 'desktop.open_notes', args: {} },
      via: 'grammar'
    })
    expect(await router.route(ownerSpeech('what is the capital of Portugal'))).toEqual({
      kind: 'ask',
      text: 'what is the capital of Portugal'
    })
    expect(await router.route(ownerSpeech('never mind'))).toEqual({ kind: 'cancelled' })
    expect(await router.route(ownerSpeech('create a note'))).toEqual({ kind: 'incomplete', missing: 'title' })
    expect(await router.route(ownerSpeech('delete my email'))).toEqual({ kind: 'unsupported' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('an action verb with no match is "can\'t do that yet", never a question to a model', async () => {
    const classify = vi.fn(async () => ({ kind: 'question' }))
    const router = createVoiceRouter({ providerReady: () => true, classify })
    expect(await router.route(ownerSpeech('send a message to Ana'))).toEqual({ kind: 'unsupported' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('unrecognised plain text goes to Ask without a classifier', async () => {
    const router = createVoiceRouter({ providerReady: () => true })
    expect(await router.route(ownerSpeech('the meeting went well'))).toEqual({
      kind: 'ask',
      text: 'the meeting went well'
    })
  })
})

describe('voice router: the optional classifier can only select a catalog entry', () => {
  const text = 'the meeting went well'
  const ready = (answer: unknown) => {
    const classify = vi.fn(async () => answer)
    return { classify, router: createVoiceRouter({ providerReady: () => true, classify }) }
  }

  it('is not asked without a ready provider', async () => {
    const classify = vi.fn(async () => ({ kind: 'question' }))
    const router = createVoiceRouter({ providerReady: () => false, classify })
    expect(await router.route(ownerSpeech(text))).toEqual({ kind: 'ask', text })
    expect(classify).not.toHaveBeenCalled()
  })

  it('passes a bounded text and a deadline, and accepts a valid catalog action', async () => {
    const { classify, router } = ready({ kind: 'action', id: 'desktop.google_search', args: { q: 'cats' } })
    expect(await router.route(ownerSpeech(`${text} ${'x'.repeat(900)}`))).toEqual({
      kind: 'action',
      request: { id: 'desktop.google_search', args: { q: 'cats' } },
      via: 'classifier'
    })
    const [sent, options] = classify.mock.calls[0] as unknown as [string, { deadlineMs: number; signal: AbortSignal }]
    expect(sent.length).toBe(500)
    expect(options.deadlineMs).toBe(VOICE_CLASSIFY_DEADLINE_MS)
  })

  it.each([
    ['an id outside the catalog', { kind: 'action', id: 'shell.exec', args: { command: 'rm -rf ~' } }],
    ['an id from another namespace', { kind: 'action', id: 'apps.quit', args: {} }],
    ['out-of-bounds arguments', { kind: 'action', id: 'desktop.create_note', args: { title: 'x'.repeat(500) } }],
    ['extra arguments', { kind: 'action', id: 'desktop.open_notes', args: { app: 'Terminal' } }],
    ['an extra field', { kind: 'action', id: 'desktop.open_notes', args: {}, confirm: true }],
    ['a control character', { kind: 'action', id: 'desktop.google_search', args: { q: 'a\u0000b' } }],
    ['a wrong shape', { action: 'open_notes' }],
    ['plain text', 'open the terminal and run it'],
    ['null', null],
    ['an explicit unsupported', { kind: 'unsupported' }]
  ])('refuses %s, never guesses', async (_label, answer) => {
    const { router } = ready(answer)
    expect(await router.route(ownerSpeech(text))).toEqual({ kind: 'unsupported' })
  })

  it("a question answer goes to Ask with the person's own text", async () => {
    const { router } = ready({ kind: 'question' })
    expect(await router.route(ownerSpeech(text))).toEqual({ kind: 'ask', text })
  })

  it('falls back to the deterministic default on a provider error or the deadline', async () => {
    const failing = createVoiceRouter({
      providerReady: () => true,
      classify: async () => {
        throw new Error('provider down')
      }
    })
    expect(await failing.route(ownerSpeech(text))).toEqual({ kind: 'ask', text })

    const slow = createVoiceRouter({ providerReady: () => true, classify: () => new Promise(() => undefined) })
    const pending = slow.route(ownerSpeech(text))
    await vi.advanceTimersByTimeAsync(VOICE_CLASSIFY_DEADLINE_MS)
    expect(await pending).toEqual({ kind: 'ask', text })
  })

  it('aborts the classifier call when it is done', async () => {
    let seen: AbortSignal | null = null
    const router = createVoiceRouter({
      providerReady: () => true,
      classify: async (_text, { signal }) => {
        seen = signal
        return { kind: 'question' }
      }
    })
    await router.route(ownerSpeech(text))
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
  })
})
