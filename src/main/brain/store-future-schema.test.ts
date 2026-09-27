import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRAIN_SCHEMA_VERSION, BrainIndexSchema } from '@shared/brain'
import type { Settings } from '@shared/ipc'

vi.mock('electron')

import { brainDir } from './store'
import { BrainIndexUnavailableError, classifyIndexBytes, indexUnavailable, loadIndex, readIndex, writeIndex } from './ledger'

function futureSchemaIndexBytes(): Buffer {
  const index = {
    ...BrainIndexSchema.parse({}),
    schema_version: BRAIN_SCHEMA_VERSION + 1
  }
  expect(BrainIndexSchema.safeParse(index).success).toBe(true)
  return Buffer.from(JSON.stringify(index), 'utf8')
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function expectBytesUnchanged(path: string, expectedSha256: string): void {
  expect(sha256(readFileSync(path))).toBe(expectedSha256)
}

describe('future schema index safety', () => {
  let folder: string
  let settings: Settings
  let primary: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-store-future-schema-'))
    settings = { meetingsFolder: folder } as Settings
    mkdirSync(join(folder, '.brain'), { recursive: true })
    primary = join(brainDir(settings), 'index.json')
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('classifies a compatible future-schema index as unsupported', () => {
    const bytes = futureSchemaIndexBytes()

    expect(classifyIndexBytes(bytes)).toEqual({ kind: 'unavailable', cause: 'unsupported' })
  })

  it('writeIndex refuses to overwrite a future-schema index', async () => {
    const bytes = futureSchemaIndexBytes()
    writeFileSync(primary, bytes)
    await loadIndex(settings)

    expect(readIndex(settings).ingested).toEqual({})
    expect(indexUnavailable(settings)).toBe('unsupported')

    const error = await writeIndex(settings, BrainIndexSchema.parse({})).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BrainIndexUnavailableError)
    if (!(error instanceof BrainIndexUnavailableError)) throw error
    expect(error.unavailable).toBe('unsupported')
    expect(error.message).toContain('brain-index-unsupported-version')
    expectBytesUnchanged(primary, sha256(bytes))
  })
})
