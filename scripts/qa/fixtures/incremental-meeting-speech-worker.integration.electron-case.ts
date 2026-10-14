import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import {
  consumeIncrementalRecordReceipt,
  type IncrementalRecordReceiptBinding
} from '../../../src/main/infra/process/incremental-record-receipt'
import { createMeetingSpeechPersistenceService } from '../../../src/main/infra/process/meeting-speech-host'

const limits: SpeechProvenanceLimits = {
  maxRecords: 4,
  maxWords: 8,
  maxFieldBytes: 1_024,
  maxRecordBytes: 4_096,
  maxPayloadBytes: 8_192
}
const bounds = {
  maxInputBytes: 16_384,
  maxOutputBytes: 16_384,
  operationDeadlineMs: 2_000,
  shutdownDeadlineMs: 2_000
}

describe('compiled Electron speech worker incremental record path', () => {
  it('canonicalizes and issues a one-use receipt through the built worker thread', async () => {
    expect(process.versions.electron).toBe('43.6.0')
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => limits,
      readBounds: () => bounds,
      isCurrent: () => true,
      entryPath: join(process.cwd(), 'out/main/meeting-speech-worker.js')
    })
    const binding: IncrementalRecordReceiptBinding = {
      ownerToken: Object.freeze(Object.create(null) as object),
      meetingId: '64d5a603-0b18-4da5-8a3f-4a42c9d22031',
      limits,
      maxCanonicalBytes: bounds.maxOutputBytes,
      isCurrent: () => true
    }
    const recordJson = new TextEncoder().encode(
      JSON.stringify({
        identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
        source: 'local-final',
        line: { speaker: 'you', text: 'compiled worker record', t: 1_700_000_000_000 }
      })
    )

    try {
      const receipt = await service.canonicalizeIncrementalRecord(recordJson, binding)
      const canonical = consumeIncrementalRecordReceipt(receipt, binding)
      expect(canonical).not.toBeNull()
      if (!canonical) return
      expect(canonical.identityKey).toBe('{"kind":"local","recordId":"6370e1cc-43f4-4976-a912-04d0c3ca8f9f"}')
      expect(Buffer.from(canonical.canonicalBytes).toString('utf8')).toContain('compiled worker record')
      expect(consumeIncrementalRecordReceipt(receipt, binding)).toBeNull()
    } finally {
      await service.dispose()
    }
  })
})
