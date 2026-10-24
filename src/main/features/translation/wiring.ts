import {
  TRANSLATION_IPC,
  TranslationResetSchema,
  TranslationRetractSchema,
  TranslationSegmentSchema,
  TranslationStatusSchema,
  type LiveTranslationTarget
} from '@shared/live-translation'
import { sendToTopFrame, type FrameLookup } from '../../ipc/top-frame-send'
import {
  createTranslationChannels,
  type TranslationChannels,
  type TranslationLogCode,
  type TranslationPush
} from './translation-channel'
import { createTranslateFn, type TranslationCallDeps } from './translation-call'

export interface LiveTranslationWiringDeps {
  /** Resolved on every call: the provider seam reads live settings and keys. */
  providerDeps(): TranslationCallDeps
  /** The chosen target, `off` when settings are unreadable. */
  readTarget(): LiveTranslationTarget
  frameFor: FrameLookup
  /** A code only; never meeting text. */
  log(code: TranslationLogCode): void
}

/**
 * Builds the live translation channels (G73) and the schema-checked pushes to a meeting's own top frame. The caller feeds
 * `onUtterance` from the transcript registry and closes channels when a meeting ends or its owner is revoked.
 */
export function bindLiveTranslation(deps: LiveTranslationWiringDeps): TranslationChannels {
  const translate = (...args: Parameters<ReturnType<typeof createTranslateFn>>) =>
    createTranslateFn(deps.providerDeps())(...args)
  const send = (
    frame: { processId: number; routingId: number },
    channel: string,
    parsed: { success: boolean; data?: unknown }
  ): void => {
    if (parsed.success) sendToTopFrame(deps.frameFor, frame, channel, parsed.data)
  }
  const push: TranslationPush = {
    segment: (frame, payload) => send(frame, TRANSLATION_IPC.segment, TranslationSegmentSchema.safeParse(payload)),
    retract: (frame, payload) => send(frame, TRANSLATION_IPC.retract, TranslationRetractSchema.safeParse(payload)),
    reset: (frame, payload) => send(frame, TRANSLATION_IPC.reset, TranslationResetSchema.safeParse(payload)),
    status: (frame, payload) => send(frame, TRANSLATION_IPC.status, TranslationStatusSchema.safeParse(payload))
  }
  return createTranslationChannels({ readTarget: deps.readTarget, translate, push, log: deps.log })
}
