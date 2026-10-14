import type { SpeechProvenanceLimits } from './meeting-speech-contract'

export interface IncrementalRecordReceiptBinding {
  readonly ownerToken: object
  readonly meetingId: string
  readonly limits: SpeechProvenanceLimits
  readonly maxCanonicalBytes: number
  readonly isCurrent: () => boolean
}

export interface IncrementalRecordReceipt {
  readonly identityKey: string
  readonly sha256: string
  readonly canonicalByteLength: number
  readonly wordCount: number
  readonly linePayloadBytes: number
  readonly clock: string
}
