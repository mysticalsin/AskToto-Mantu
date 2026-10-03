import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodTypeAny } from 'zod'
import { CaptureSchema, SpeechSegmentSchema, SpeechStreamRefSchema } from './index'

/**
 * Golden and negative fixtures of the speech contract (TASK-005, M2-0064), each named `<schema>.<case>.json`.
 * Every golden parses. Every negative is rejected with exactly one issue, at the path of the invariant it
 * breaks, so a negative that fails for an unrelated reason fails this suite.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

const SCHEMAS: Record<string, ZodTypeAny> = {
  capture: CaptureSchema,
  stream: SpeechStreamRefSchema,
  segment: SpeechSegmentSchema
}

/** Each negative fixture, and the path of the one issue it must be rejected with. */
const REJECTED_AT: Record<string, Array<string | number>> = {
  'capture.captured-not-requested.json': ['capturedTracks', 0],
  'capture.captured-twice.json': ['capturedTracks', 1],
  'capture.fallback-engine-key.json': [],
  'capture.generation-zero.json': ['generation'],
  'capture.no-requested-track.json': ['requestedTracks'],
  'capture.requested-twice.json': ['requestedTracks', 1],
  'capture.unknown-track.json': ['requestedTracks', 0],
  'segment.ends-before-start.json': ['endMs'],
  'segment.generation-engine.json': ['engine'],
  'segment.missing-stream-epoch.json': ['stream', 'epoch'],
  'segment.revision-zero.json': ['revision'],
  'stream.epoch-zero.json': ['epoch'],
  'stream.fractional-generation.json': ['generation']
}

type Fixture = { file: string; schema: ZodTypeAny; value: unknown }

function loadFixtures(kind: 'golden' | 'negative'): Fixture[] {
  const directory = join(FIXTURES, kind)
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const schema = SCHEMAS[file.split('.')[0]]
      if (!schema) throw new Error(`${kind}/${file} does not start with the name of a contract schema`)
      return { file, schema, value: JSON.parse(readFileSync(join(directory, file), 'utf8')) }
    })
}

const golden = loadFixtures('golden')
const negative = loadFixtures('negative')

function goldenValue(file: string): unknown {
  const fixture = golden.find((candidate) => candidate.file === file)
  if (!fixture) throw new Error(`golden/${file} is missing`)
  return fixture.value
}

describe('speech contract: golden fixtures', () => {
  it.each(golden.map((fixture) => [fixture.file, fixture] as const))('%s parses', (_file, fixture) => {
    const result = fixture.schema.safeParse(fixture.value)
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
  })

  it('report a requested track that is not captured instead of dropping the request', () => {
    const capture = CaptureSchema.parse(goldenValue('capture.system-audio-denied.json'))
    expect(capture.requestedTracks).toEqual(['microphone', 'system'])
    expect(capture.capturedTracks).toEqual(['microphone'])
  })

  it('carry a later revision of the same segment, from the same stream epoch', () => {
    const partial = SpeechSegmentSchema.parse(goldenValue('segment.partial.json'))
    const final = SpeechSegmentSchema.parse(goldenValue('segment.final.json'))
    expect(final.stream).toEqual(partial.stream)
    expect(final.index).toBe(partial.index)
    expect(final.revision).toBeGreaterThan(partial.revision)
    expect([partial.final, final.final]).toEqual([false, true])
  })
})

describe('speech contract: negative fixtures', () => {
  it('each name the path they are rejected at', () => {
    expect(negative.map((fixture) => fixture.file)).toEqual(Object.keys(REJECTED_AT).sort())
  })

  it.each(negative.map((fixture) => [fixture.file, fixture] as const))(
    '%s is rejected at its invariant',
    (file, fixture) => {
      const result = fixture.schema.safeParse(fixture.value)
      expect(result.success).toBe(false)
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([REJECTED_AT[file]])
    }
  )
})
