import { describe, expect, it } from 'vitest'
import type { TranscriptLine } from '@shared/transcript-line'
import {
  decodeMeetingSpeech,
  encodeSpeechTranscript,
  projectMeetingSpeech,
  type SpeechProvenanceLimits
} from './speech-provenance'

const limits: SpeechProvenanceLimits = {
  maxRecords: 10,
  maxWords: 20,
  maxFieldBytes: 10_000,
  maxRecordBytes: 20_000,
  maxPayloadBytes: 100_000
}
const line: TranscriptLine = {
  speaker: 'them',
  text: 'Bonjour team.',
  t: 1_700_000_000_125,
  speech: {
    type: 'segment',
    captureId: '11111111-1111-4111-8111-111111111111',
    captureGeneration: 2,
    sequence: 9,
    segment: {
      stream: { generation: 2, track: 'system', epoch: 3 },
      engine: 'deepgram-nova3',
      index: 4,
      revision: 2,
      final: true,
      text: 'Bonjour team.',
      startMs: 0,
      endMs: 1000
    },
    languages: ['fr', 'en'],
    words: [
      { text: 'Bonjour', startMs: 0, endMs: 500, language: 'fr' },
      { text: 'team', startMs: 500, endMs: 1000, language: 'en' }
    ]
  }
}

describe('bounded meeting speech codec', () => {
  it('retains mixed lines, exact subsecond times and legitimate sequence gaps across CRLF', () => {
    const lines = [line, { speaker: 'unknown' as const, text: 'Legacy sentence', t: line.t + 120 }]
    const encoded = encodeSpeechTranscript(lines, limits)
    const decoded = decodeMeetingSpeech(`## Full transcript\n\n${encoded}`.replaceAll('\n', '\r\n'), limits)
    expect(decoded.ok && decoded.status).toBe('valid')
    if (decoded.ok && decoded.status === 'valid') expect(decoded.lines).toEqual(lines)
    expect(projectMeetingSpeech(encoded)).toEqual({
      ok: true,
      publicMarkdown: expect.stringContaining('Bonjour team.')
    })
    const projected = projectMeetingSpeech(encoded)
    if (projected.ok) {
      expect(projected.publicMarkdown).not.toContain('captureId')
      expect(projected.publicMarkdown).not.toContain('11111111')
    }
  })

  it('rejects text edits even when the metadata JSON stays intact', () => {
    const encoded = encodeSpeechTranscript([line], limits)
    const decoded = decodeMeetingSpeech(encoded.replace('Bonjour team.', 'Edited human sentence.'), limits)
    expect(decoded.ok && decoded.status).toBe('unavailable')
  })

  it('refuses ambiguous and orphan frames rather than returning potentially private text', () => {
    const encoded = encodeSpeechTranscript([line], limits)
    expect(projectMeetingSpeech(encoded + encoded)).toEqual({ ok: false, reason: 'FRAME_AMBIGUOUS' })
    expect(projectMeetingSpeech('Ordinary text\n<!-- /metis-speech-provenance -->')).toEqual({
      ok: false,
      reason: 'FRAME_AMBIGUOUS'
    })
  })

  it('removes a uniquely opened incomplete private frame from public output', () => {
    expect(projectMeetingSpeech('Public\n<!-- metis-speech-provenance:v1 -->\n{"private":"sentinel"}')).toEqual({
      ok: true,
      publicMarkdown: 'Public\n'
    })
  })

  it('escapes reserved marker text in actual user speech without making additional frames', () => {
    const text = 'Spoken\n<!-- /metis-speech-provenance -->\n## Debrief'
    const input = { ...line, text, speech: { ...line.speech!, segment: { ...line.speech!.segment, text } } }
    const decoded = decodeMeetingSpeech(encodeSpeechTranscript([input], limits), limits)
    expect(decoded.ok && decoded.status).toBe('valid')
    if (decoded.ok && decoded.status === 'valid') expect(decoded.lines[0].text).toBe(text)
  })

  it('rejects forged line association independently of a matching display hash', () => {
    const encoded = encodeSpeechTranscript([line], limits)
    const altered = encoded
      .replace('"t":1700000000125', '"t":1700000000126')
      .replaceAll('"text":"Bonjour team."', '"text":"Other sentence."')
    expect(decodeMeetingSpeech(altered, limits)).toMatchObject({ ok: true, status: 'unavailable' })
  })

  it.each([NaN, Infinity, 8.64e15 + 1])('rejects invalid Date timestamp %s before serialization', (t) => {
    expect(() => encodeSpeechTranscript([{ ...line, t }], limits)).toThrow('Speech metadata could not be retained.')
  })

  it('checks records, words, fields and actual escaped bytes at limit and limit+1', () => {
    const encoded = encodeSpeechTranscript([line], { ...limits, maxRecords: 1, maxWords: 2 })
    expect(decodeMeetingSpeech(encoded, limits)).toMatchObject({ ok: true, status: 'valid' })
    expect(() => encodeSpeechTranscript([line, line], { ...limits, maxRecords: 1 })).toThrow()
    expect(() => encodeSpeechTranscript([line], { ...limits, maxWords: 1 })).toThrow()
    expect(() => encodeSpeechTranscript([line], { ...limits, maxFieldBytes: 2 })).toThrow()
    expect(() => encodeSpeechTranscript([line], { ...limits, maxPayloadBytes: 1 })).toThrow()
  })

  it('requires finite trusted budgets and refuses repeated final segment identity', () => {
    expect(() => encodeSpeechTranscript([line], { ...limits, maxPayloadBytes: Infinity })).toThrow()
    expect(() => encodeSpeechTranscript([line, line], limits)).toThrow()
  })

  it('checks the exact escaped payload byte boundary and rejects malformed private JSON without publishing it', () => {
    const encoded = encodeSpeechTranscript([line], limits)
    const payload = encoded
      .split('<!-- metis-speech-provenance:v1 -->\n')[1]
      .split('\n<!-- /metis-speech-provenance -->')[0]
    const size = Buffer.byteLength(payload)
    expect(
      decodeMeetingSpeech(encodeSpeechTranscript([line], { ...limits, maxPayloadBytes: size }), limits)
    ).toMatchObject({ ok: true, status: 'valid' })
    expect(() => encodeSpeechTranscript([line], { ...limits, maxPayloadBytes: size - 1 })).toThrow()
    const invalid = encoded.replace(payload, '{not JSON; private sentinel}')
    expect(decodeMeetingSpeech(invalid, limits)).toMatchObject({ ok: true, status: 'unavailable' })
    const projected = projectMeetingSpeech(invalid)
    expect(projected.ok && projected.publicMarkdown.includes('private sentinel')).toBe(false)
  })

  it('checks exact record bytes and optional word evidence without inventing words', () => {
    const recordBytes = Buffer.byteLength(JSON.stringify(line))
    expect(() => encodeSpeechTranscript([line], { ...limits, maxRecordBytes: recordBytes })).not.toThrow()
    expect(() => encodeSpeechTranscript([line], { ...limits, maxRecordBytes: recordBytes - 1 })).toThrow()
    const { words: _words, ...speech } = line.speech!
    const withoutWords = { ...line, speech }
    const decoded = decodeMeetingSpeech(encodeSpeechTranscript([withoutWords], limits), limits)
    expect(decoded.ok && decoded.status).toBe('valid')
    if (decoded.ok && decoded.status === 'valid') expect(decoded.lines[0].speech?.words).toBeUndefined()
  })

  it('retains exact CRLF user text while normalizing only its saved display projection', () => {
    const text = 'Bonjour\r\nteam.'
    const input = { ...line, text, speech: { ...line.speech!, segment: { ...line.speech!.segment, text } } }
    const decoded = decodeMeetingSpeech(encodeSpeechTranscript([input], limits), limits)
    expect(decoded.ok && decoded.status).toBe('valid')
    if (decoded.ok && decoded.status === 'valid') expect(decoded.lines[0].text).toBe(text)
  })

  it('rejects unsupported private versions on typed read but strips their uniquely framed payload publicly', () => {
    const future = encodeSpeechTranscript([line], limits).replace(
      'metis-speech-provenance:v1',
      'metis-speech-provenance:v2'
    )
    expect(decodeMeetingSpeech(future, limits)).toMatchObject({ ok: true, status: 'unavailable' })
    const projected = projectMeetingSpeech(future)
    expect(projected.ok && projected.publicMarkdown.includes('captureId')).toBe(false)
  })

  it('refuses malformed reserved delimiter syntax rather than leaking the private payload', () => {
    const malformed = encodeSpeechTranscript([line], limits).replace(
      'metis-speech-provenance:v1 -->',
      'metis-speech-provenance:v1-->'
    )
    expect(projectMeetingSpeech(malformed)).toEqual({ ok: false, reason: 'FRAME_AMBIGUOUS' })
  })
})
