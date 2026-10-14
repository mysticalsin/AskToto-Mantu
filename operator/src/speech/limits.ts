export const SPEECH_STREAM_AUTHORITY_MS = 60_000
export const SPEECH_DRAIN_WINDOW_MS = 5_000
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024
export const MAX_PENDING_BYTES = 64 * 1024
export const MAX_INPUT_BYTES_PER_TRACK = 1_920_000
export const MAX_CLIENT_MESSAGES = 4_096
export const MAX_PROVIDER_MESSAGES = 4_096
export const MAX_OUTPUT_FRAME_BYTES = 64 * 1024
export const MAX_OUTPUT_BYTES_PER_TRACK = 1024 * 1024
export const RESERVED_TERMINAL_BYTES = 1_024

export type SpeechLimitCode =
  | 'FRAME_TOO_LARGE'
  | 'PENDING_LIMIT'
  | 'INPUT_LIMIT'
  | 'MESSAGE_LIMIT'
  | 'LEASE_DRAINING'
  | 'OUTPUT_FRAME_LIMIT'
  | 'OUTPUT_LIMIT'

export interface SpeechStreamBudget {
  startedAt: number
  deadlineAt: number
  inputBytes: number
  pendingBytes: number
  clientMessages: number
  outputBytes: number
  providerMessages: number
}

export function createSpeechStreamBudget(startedAt: number, deadlineAt: number): SpeechStreamBudget {
  return {
    startedAt,
    deadlineAt,
    inputBytes: 0,
    pendingBytes: 0,
    clientMessages: 0,
    outputBytes: 0,
    providerMessages: 0
  }
}

export function enqueueSpeechAudio(
  budget: SpeechStreamBudget,
  bytes: number,
  now: number
): { ok: true } | { ok: false; code: SpeechLimitCode } {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CLIENT_FRAME_BYTES)
    return { ok: false, code: 'FRAME_TOO_LARGE' }
  if (now >= budget.deadlineAt - SPEECH_DRAIN_WINDOW_MS) return { ok: false, code: 'LEASE_DRAINING' }
  if (budget.clientMessages >= MAX_CLIENT_MESSAGES) return { ok: false, code: 'MESSAGE_LIMIT' }
  if (budget.pendingBytes + bytes > MAX_PENDING_BYTES) return { ok: false, code: 'PENDING_LIMIT' }
  if (budget.inputBytes + bytes > MAX_INPUT_BYTES_PER_TRACK) return { ok: false, code: 'INPUT_LIMIT' }
  budget.inputBytes += bytes
  budget.pendingBytes += bytes
  budget.clientMessages += 1
  return { ok: true }
}

export function finishSpeechAudio(budget: SpeechStreamBudget, bytes: number): void {
  budget.pendingBytes = Math.max(0, budget.pendingBytes - bytes)
}

export function discardSpeechAudio(budget: SpeechStreamBudget, bytes: number): void {
  finishSpeechAudio(budget, bytes)
  budget.inputBytes = Math.max(0, budget.inputBytes - bytes)
  budget.clientMessages = Math.max(0, budget.clientMessages - 1)
}

export function enqueueSpeechProviderFrame(
  budget: SpeechStreamBudget,
  bytes: number
): { ok: true } | { ok: false; code: SpeechLimitCode } {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_OUTPUT_FRAME_BYTES)
    return { ok: false, code: 'OUTPUT_FRAME_LIMIT' }
  if (budget.providerMessages >= MAX_PROVIDER_MESSAGES) return { ok: false, code: 'MESSAGE_LIMIT' }
  if (budget.pendingBytes + bytes > MAX_PENDING_BYTES) return { ok: false, code: 'PENDING_LIMIT' }
  budget.pendingBytes += bytes
  budget.providerMessages += 1
  return { ok: true }
}

export function finishSpeechProviderFrame(budget: SpeechStreamBudget, bytes: number): void {
  budget.pendingBytes = Math.max(0, budget.pendingBytes - bytes)
}

export function accountSpeechOutput(
  budget: SpeechStreamBudget,
  bytes: number,
  countMessage = true
): { ok: true } | { ok: false; code: SpeechLimitCode } {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_OUTPUT_FRAME_BYTES)
    return { ok: false, code: 'OUTPUT_FRAME_LIMIT' }
  if (countMessage && budget.providerMessages >= MAX_PROVIDER_MESSAGES) return { ok: false, code: 'MESSAGE_LIMIT' }
  if (budget.outputBytes + bytes > MAX_OUTPUT_BYTES_PER_TRACK - RESERVED_TERMINAL_BYTES)
    return { ok: false, code: 'OUTPUT_LIMIT' }
  budget.outputBytes += bytes
  if (countMessage) budget.providerMessages += 1
  return { ok: true }
}
