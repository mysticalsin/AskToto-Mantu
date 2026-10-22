/**
 * Voice router (V03): one recognized utterance becomes one route.
 *
 *   1. The deterministic grammar (en, fr, pt, es) names an action, a question, a cancellation, an incomplete
 *      request or an unsupported one. This is the only step that needs no network and it decides almost
 *      everything.
 *   2. Only when the grammar recognised nothing, a provider is ready AND a classifier was supplied, the text is
 *      offered to the classifier with a hard deadline. The classifier can only pick a catalog entry and fill its
 *      bounded slots: its answer is parsed against a strict schema and then validated by the catalog like any
 *      other request, and anything outside the catalog is refused, never guessed. It can never create authority:
 *      the policy decides what runs, and a turn claim must still be valid.
 *   3. Anything left is a question for the Ask path, unless it opens with a verb that asks for something to be
 *      done: that is "can't do that yet", never a confusing question to a model.
 *
 * The classifier is a seam, not a provider binding: this module resolves no model, key or endpoint. What it is
 * given is the same text a typed Ask would send, under the same disclosure.
 */
import { z } from 'zod'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { validateDesktopRequest } from '@shared/voice/catalog'
import { looksLikeQuestion, parseVoiceUtterance, startsWithActionVerb } from '@shared/voice/voice-grammar'

export type VoiceRoute =
  | { kind: 'action'; request: DesktopActionRequest; via: 'grammar' | 'classifier' }
  | { kind: 'ask'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'incomplete'; missing: 'title' | 'query' | 'too_long' }
  | { kind: 'unsupported' }

/** The 2.5 s the design allows a classification before the router moves on. */
export const VOICE_CLASSIFY_DEADLINE_MS = 2_500
const CLASSIFY_TEXT_MAX_CHARS = 500

/** What the classifier may answer. Strict: an extra field or a wrong shape is a refusal. */
const ClassificationSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('action'), id: z.string().max(64), args: z.record(z.string(), z.unknown()).default({}) })
    .strict(),
  z.object({ kind: z.literal('question') }).strict(),
  z.object({ kind: z.literal('unsupported') }).strict()
])

export interface VoiceRouterDeps {
  /** An AI provider is configured and allowed. The classifier never runs without it. */
  providerReady(): boolean
  /** Returns the model's raw answer. Absent: the router never asks a model to classify. */
  classify?(text: string, options: { signal: AbortSignal; deadlineMs: number }): Promise<unknown>
  deadlineMs?: number
}

export interface VoiceRouter {
  route(text: string): Promise<VoiceRoute>
}

export function createVoiceRouter(deps: VoiceRouterDeps): VoiceRouter {
  const deadlineMs = deps.deadlineMs ?? VOICE_CLASSIFY_DEADLINE_MS
  const leftover = (text: string): VoiceRoute =>
    startsWithActionVerb(text) && !looksLikeQuestion(text)
      ? { kind: 'unsupported' }
      : { kind: 'ask', text: text.trim() }

  async function classify(text: string): Promise<VoiceRoute | null> {
    if (!deps.classify || !deps.providerReady()) return null
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        deps.classify(text.slice(0, CLASSIFY_TEXT_MAX_CHARS), { signal: controller.signal, deadlineMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('deadline')), deadlineMs)
        })
      ])
      const parsed = ClassificationSchema.safeParse(answer)
      if (!parsed.success) return { kind: 'unsupported' }
      if (parsed.data.kind === 'question') return { kind: 'ask', text: text.trim() }
      if (parsed.data.kind === 'unsupported') return { kind: 'unsupported' }
      // The catalog is the only authority on what exists and what its arguments may hold.
      const request = validateDesktopRequest({ id: parsed.data.id, args: parsed.data.args })
      return request ? { kind: 'action', request, via: 'classifier' } : { kind: 'unsupported' }
    } catch {
      // Deadline, provider error or abort: fall back to the deterministic default, never to a guess.
      return null
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }

  return {
    async route(text) {
      const utterance = parseVoiceUtterance(text)
      switch (utterance.kind) {
        case 'action':
          return { kind: 'action', request: utterance.request, via: 'grammar' }
        case 'question':
          return { kind: 'ask', text: utterance.text }
        case 'cancelled':
          return { kind: 'cancelled' }
        case 'incomplete':
          return { kind: 'incomplete', missing: utterance.missing }
        case 'unsupported':
          return { kind: 'unsupported' }
        case 'none': {
          const classified = await classify(text)
          return classified ?? leftover(text)
        }
      }
    }
  }
}
