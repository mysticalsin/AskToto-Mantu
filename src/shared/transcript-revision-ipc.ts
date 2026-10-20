export const TRANSCRIPT_REVISION_IPC = { revision: 'transcript:revision' } as const

export { TranscriptRevisionDeltaSchema, type TranscriptRevisionDelta } from './contracts/speech/transcript-revision'

export const TRANSCRIPT_REVISION_MAX_SUBSCRIPTIONS = 8
