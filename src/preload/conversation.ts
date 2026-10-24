import type { IpcRenderer } from 'electron'
import { z, type ZodType } from 'zod'
import {
  ConversationSnapshotSchema,
  ConversationStartResultSchema,
  ConversationStopResultSchema,
  ConversationAskSchema,
  ConversationReplyCompleteSchema,
  ConversationCaptureBeginSchema,
  ConversationCaptureCancelSchema,
  ConversationCaptureFailureSchema,
  ConversationCaptureFrameSchema,
  ConversationCaptureFinishSchema,
  ConversationCaptureStartSchema,
  CONVERSATION_IPC,
  type ConversationSnapshot,
  type ConversationAsk,
  type ConversationCaptureBegin,
  type ConversationCaptureBinding,
  type ConversationCaptureFailure
} from '../shared/conversation/conversation-session'
import { InputSessionResultSchema, InputSessionStartRequestSchema, type InputSessionContext, type InputSessionResult } from '../shared/input-session'
import { IPC } from '../shared/ipc'

type Unsub = () => void
type TrustedClick = { isTrusted: boolean; composedPath(): unknown[] }
type Doc = {
  addEventListener(type: 'click', cb: (event: TrustedClick) => void, capture: boolean): void
  querySelectorAll(selector: string): { length: number }
}

const CaptureResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: ConversationCaptureFailureSchema.shape.reason }).strict()
])
type CaptureResult = z.infer<typeof CaptureResultSchema>
const CAPTURE_RESULT_FALLBACK: CaptureResult = { ok: false, reason: 'recognition_unavailable' }

function parseResult<T>(schema: ZodType<T>, raw: unknown, fallback: T): T {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : fallback
}

export function createConversationPreloadApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>, doc?: Doc) {
  let trustedStart: Promise<boolean> | null = null
  doc?.addEventListener('click', (event) => {
    const nodes = event.composedPath()
    const button = nodes.find(
      (node): node is {
        tagName: string
        type: string
        disabled: boolean
        isConnected: boolean
        hasAttribute(name: string): boolean
        getClientRects(): { length: number }
      } =>
        !!node &&
        typeof node === 'object' &&
        'hasAttribute' in node &&
        typeof (node as { hasAttribute?: unknown }).hasAttribute === 'function' &&
        (node as { hasAttribute(name: string): boolean }).hasAttribute('data-metis-conversation-start')
    )
    const valid =
      event.isTrusted &&
      !!button &&
      button.tagName === 'BUTTON' &&
      button.type === 'button' &&
      !button.disabled &&
      button.isConnected &&
      button.hasAttribute('data-metis-conversation-start') &&
      button.getClientRects().length > 0 &&
      doc?.querySelectorAll('[data-metis-conversation-start]').length === 1
    if (!valid) {
      trustedStart = null
      void ipc.invoke(CONVERSATION_IPC.startActivationCancel).catch(() => false)
      return
    }
    trustedStart = ipc.invoke(CONVERSATION_IPC.startActivationObserved).then((ok) => ok === true).catch(() => false)
  }, true)
  const sub = <T>(channel: string, schema: ZodType<T>, cb: (value: T) => void): Unsub => {
    const listener = (_event: unknown, raw: unknown): void => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) return
      try {
        cb(parsed.data)
      } catch {
        /* a renderer subscriber cannot break the preload event bridge */
      }
    }
    ipc.on(channel, listener)
    return () => ipc.removeListener(channel, listener)
  }
  return { conversation: {
    async start() {
      const observed = trustedStart; trustedStart = null
      if (!observed || !(await observed)) return { ok: false as const, reason: 'policy_blocked' as const }
      const result = await ipc.invoke(CONVERSATION_IPC.start)
      return parseResult(ConversationStartResultSchema, result, { ok: false, reason: 'not_ready' })
    },
    async stop() {
      return parseResult(ConversationStopResultSchema, await ipc.invoke(CONVERSATION_IPC.stop), { ok: false })
    },
    async getState(): Promise<ConversationSnapshot | null> {
      const parsed = ConversationSnapshotSchema.safeParse(await ipc.invoke(CONVERSATION_IPC.getState))
      return parsed.success ? parsed.data : null
    },
    onState: (cb: (snapshot: ConversationSnapshot) => void) => sub(CONVERSATION_IPC.state, ConversationSnapshotSchema, cb),
    onCaptureBegin: (cb: (event: ConversationCaptureBegin) => void) => sub(CONVERSATION_IPC.captureBegin, ConversationCaptureBeginSchema, cb),
    onCaptureCancel: (cb: (event: ConversationCaptureBinding) => void) => sub(CONVERSATION_IPC.captureCancel, ConversationCaptureCancelSchema, cb),
    onAsk: (cb: (ask: ConversationAsk) => void) => sub(CONVERSATION_IPC.ask, ConversationAskSchema, cb),
    captureStart: async (begin: ConversationCaptureBegin): Promise<CaptureResult> => {
      const validBegin = ConversationCaptureBeginSchema.safeParse(begin)
      if (!validBegin.success) return CAPTURE_RESULT_FALLBACK
      const binding = { sessionId: validBegin.data.sessionId, captureToken: validBegin.data.captureToken }
      const payload = ConversationCaptureStartSchema.safeParse({
        ...binding,
        maxSeconds: Math.ceil(validBegin.data.maxMs / 1_000)
      })
      if (!payload.success) return CAPTURE_RESULT_FALLBACK
      return parseResult(CaptureResultSchema, await ipc.invoke(CONVERSATION_IPC.captureStart, payload.data), CAPTURE_RESULT_FALLBACK)
    },
    async captureFrame(binding: ConversationCaptureBinding, sequence: number, samples: Float32Array): Promise<CaptureResult> {
      const payload = ConversationCaptureFrameSchema.safeParse({ ...binding, sequence, samples })
      if (!payload.success) return CAPTURE_RESULT_FALLBACK
      return parseResult(CaptureResultSchema, await ipc.invoke(CONVERSATION_IPC.captureFrame, payload.data), CAPTURE_RESULT_FALLBACK)
    },
    async captureFinish(binding: ConversationCaptureBinding, frameCount: number): Promise<CaptureResult> {
      const payload = ConversationCaptureFinishSchema.safeParse({ ...binding, frameCount })
      if (!payload.success) return CAPTURE_RESULT_FALLBACK
      return parseResult(CaptureResultSchema, await ipc.invoke(CONVERSATION_IPC.captureFinish, payload.data), CAPTURE_RESULT_FALLBACK)
    },
    async captureCancel(binding: ConversationCaptureBinding): Promise<CaptureResult> {
      const payload = ConversationCaptureCancelSchema.safeParse(binding)
      if (!payload.success) return CAPTURE_RESULT_FALLBACK
      return parseResult(CaptureResultSchema, await ipc.invoke(CONVERSATION_IPC.captureCancelRequest, payload.data), CAPTURE_RESULT_FALLBACK)
    },
    async reportCaptureFailure(failure: ConversationCaptureFailure): Promise<boolean> {
      const payload = ConversationCaptureFailureSchema.safeParse(failure)
      if (!payload.success) return false
      const result = await ipc.invoke(CONVERSATION_IPC.captureFailure, payload.data)
      return result === true
    },
    async replyFinished(sessionId: string, replyGeneration: number): Promise<boolean> {
      const payload = ConversationReplyCompleteSchema.safeParse({ sessionId, replyGeneration })
      if (!payload.success) return false
      return (await ipc.invoke(CONVERSATION_IPC.replyFinished, payload.data)) === true
    },
    async startCapture(captureToken: string, context: InputSessionContext): Promise<InputSessionResult> {
      const token = ConversationCaptureCancelSchema.shape.captureToken.safeParse(captureToken)
      if (!token.success) return { ok: false, reason: 'invalid_request' }
      const request = InputSessionStartRequestSchema.safeParse({ input: { source: 'push-to-talk', purpose: 'conversation', activation: 'explicit' }, context, conversationCaptureToken: token.data })
      if (!request.success) return { ok: false, reason: 'invalid_request' }
      return parseResult(InputSessionResultSchema, await ipc.invoke(IPC.inputSessionStart, request.data), { ok: false, reason: 'invalid_request' })
    }
  } }
}
