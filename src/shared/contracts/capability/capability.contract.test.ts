import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodTypeAny } from 'zod'
import { CapabilitiesSchema, GenerationCapabilitySchema, SpeechCapabilitySchema } from './index'

/**
 * Golden and negative fixtures of the capability contract (TASK-005, M2-0064), each named
 * `<schema>.<case>.json`. Every golden parses. Every negative is rejected with exactly one issue, at the path
 * of the invariant it breaks, so a negative that fails for an unrelated reason fails this suite.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

const SCHEMAS: Record<string, ZodTypeAny> = {
  speech: SpeechCapabilitySchema,
  generation: GenerationCapabilitySchema,
  capabilities: CapabilitiesSchema
}

/** Each negative fixture, and the path of the one issue it must be rejected with. */
const REJECTED_AT: Record<string, Array<string | number>> = {
  'capabilities.generation-missing.json': ['generation'],
  'capabilities.speech-in-generation-slot.json': ['generation', 'capability'],
  'generation.not-ready-reported-ready.json': ['status', 'state'],
  'generation.speech-engine.json': ['selected'],
  'speech.allowed-twice.json': ['allowed', 1],
  'speech.fallback-key.json': [],
  'speech.generation-engine.json': ['selected'],
  'speech.labelled-generation.json': ['capability'],
  'speech.not-ready-reported-ready.json': ['status', 'state'],
  'speech.not-ready-without-reason.json': ['status', 'reason'],
  'speech.ready-not-allowed.json': ['ready', 1],
  'speech.ready-reported-not-ready.json': ['status', 'state'],
  'speech.selected-not-allowed.json': ['selected']
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

describe('capability contract: golden fixtures', () => {
  it.each(golden.map((fixture) => [fixture.file, fixture] as const))('%s parses', (_file, fixture) => {
    const result = fixture.schema.safeParse(fixture.value)
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
  })

  it('report a selected engine that is not ready as not ready, even when another allowed engine is ready', () => {
    const speech = SpeechCapabilitySchema.parse(goldenValue('speech.selected-not-ready.json'))
    expect(speech.ready).toContain('parakeet')
    expect(speech.selected).toBe('cloudflare-nova3')
    expect(speech.status).toEqual({ state: 'not-ready', reason: 'unreachable' })
  })

  it('keep speech readiness apart from generation readiness', () => {
    const capabilities = CapabilitiesSchema.parse(goldenValue('capabilities.speech-not-ready-generation-ready.json'))
    expect(capabilities.speech.status.state).toBe('not-ready')
    expect(capabilities.generation.status.state).toBe('ready')
  })

  it('do not let a speech capability stand in for generation, or the reverse', () => {
    expect(GenerationCapabilitySchema.safeParse(goldenValue('speech.cloud-default-ready.json')).success).toBe(false)
    expect(SpeechCapabilitySchema.safeParse(goldenValue('generation.ready.json')).success).toBe(false)
  })
})

describe('capability contract: negative fixtures', () => {
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
