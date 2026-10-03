import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TranscriptLineSchema } from '../../ipc'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

type Fixture = { file: string; value: unknown }

function loadFixtures(kind: 'golden' | 'negative'): Fixture[] {
  const directory = join(FIXTURES, kind)
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, value: JSON.parse(readFileSync(join(directory, file), 'utf8')) }))
}

const golden = loadFixtures('golden')
const negative = loadFixtures('negative')

describe('transcript contract: golden fixtures', () => {
  it.each(golden.map((fixture) => [fixture.file, fixture] as const))('%s parses', (_file, fixture) => {
    const result = TranscriptLineSchema.safeParse(fixture.value)
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
  })

  it('keeps Electron speaker labels canonical', () => {
    const speakers = golden.map((fixture) => TranscriptLineSchema.parse(fixture.value).speaker)
    expect(speakers.sort()).toEqual(['them', 'unknown', 'you'])
  })
})

describe('transcript contract: negative fixtures', () => {
  it.each(negative.map((fixture) => [fixture.file, fixture] as const))('%s is rejected', (_file, fixture) => {
    expect(TranscriptLineSchema.safeParse(fixture.value).success).toBe(false)
  })
})
