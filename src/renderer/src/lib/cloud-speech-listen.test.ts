import { describe, expect, it } from 'vitest'
import { buildCloudSpeechStartRequest, cloudSpeechTranscriptSegment } from './cloud-speech-listen'

const capture = {
  generation: 3,
  engine: 'deepgram-nova3',
  requestedTracks: ['microphone', 'system'],
  capturedTracks: ['microphone']
} as const

describe('buildCloudSpeechStartRequest', () => {
  it('binds accepted consent to exact acquired tracks and generation', () => {
    expect(
      buildCloudSpeechStartRequest({
        captureId: '7eb44d11-8d93-4c87-a83d-9299a1e1f2d4',
        capture,
        language: 'multi',
        consent: {
          engine: 'deepgram-nova3',
          requestedTracks: ['microphone', 'system'],
          disclosureVersion: 'cloud-speech-v1'
        }
      })
    ).toEqual({
      captureId: '7eb44d11-8d93-4c87-a83d-9299a1e1f2d4',
      capture,
      language: 'multi',
      consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
    })
  })

  it('refuses missing consent, invalid identity, language, and empty actual capture', () => {
    const input = {
      captureId: '7eb44d11-8d93-4c87-a83d-9299a1e1f2d4',
      capture,
      language: 'multi',
      consent: {
        engine: 'deepgram-nova3',
        requestedTracks: ['microphone', 'system'],
        disclosureVersion: 'cloud-speech-v1'
      }
    }
    expect(buildCloudSpeechStartRequest({ ...input, consent: undefined })).toBeNull()
    expect(
      buildCloudSpeechStartRequest({
        ...input,
        consent: { ...input.consent, engine: 'cloudflare-nova3' }
      })
    ).toBeNull()
    expect(
      buildCloudSpeechStartRequest({ ...input, consent: { ...input.consent, requestedTracks: ['microphone'] } })
    ).toBeNull()
    expect(buildCloudSpeechStartRequest({ ...input, captureId: 'listen:3' })).toBeNull()
    expect(buildCloudSpeechStartRequest({ ...input, language: 'English' })).toBeNull()
    expect(buildCloudSpeechStartRequest({ ...input, capture: { ...capture, capturedTracks: [] } })).toBeNull()
  })
})

describe('cloudSpeechTranscriptSegment', () => {
  const finalEvent = {
    type: 'segment',
    captureId: '7eb44d11-8d93-4c87-a83d-9299a1e1f2d4',
    captureGeneration: 3,
    sequence: 8,
    segment: {
      stream: { generation: 3, track: 'system', epoch: 4 },
      engine: 'deepgram-nova3',
      index: 5,
      revision: 2,
      final: true,
      text: 'Yes. Yes.',
      startMs: 100,
      endMs: 900
    },
    languages: ['fr-CA'],
    words: [{ text: 'Oui.', startMs: 100, endMs: 300, language: 'fr-CA' }]
  } as const

  it('preserves provider text, actual metadata, and a stable per-segment identity', () => {
    expect(cloudSpeechTranscriptSegment(finalEvent)).toEqual({
      text: 'Yes. Yes.',
      speaker: 'them',
      segmentId: '3:system:4:5',
      providerLanguage: 'fr-CA',
      speech: finalEvent
    })
  })

  it('keeps repeated words as distinct provider segments and does not promote an interim revision', () => {
    const nextSegment = {
      ...finalEvent,
      sequence: 9,
      segment: { ...finalEvent.segment, index: 6 }
    }
    expect(cloudSpeechTranscriptSegment(nextSegment)?.segmentId).toBe('3:system:4:6')
    expect(cloudSpeechTranscriptSegment({ ...finalEvent, segment: { ...finalEvent.segment, final: false } })).toBeNull()
  })

  it('leaves mixed-language lines untagged while retaining every language in the event', () => {
    const mixed = {
      ...finalEvent,
      languages: ['en', 'fr-CA'],
      words: [{ text: 'Yes.', startMs: 100, endMs: 300, language: 'en' }]
    }
    expect(cloudSpeechTranscriptSegment(mixed)).toMatchObject({
      speech: mixed,
      text: 'Yes. Yes.',
      segmentId: '3:system:4:5'
    })
    expect(cloudSpeechTranscriptSegment(mixed)?.providerLanguage).toBeUndefined()
  })
})
