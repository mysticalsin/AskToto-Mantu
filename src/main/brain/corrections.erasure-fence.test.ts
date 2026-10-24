import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Settings } from '@shared/ipc'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { configureErasureFence, createErasureFence, erasureFenceFile } from '../memory-partition/erasure-fence'
import { brainDir } from './brain-root'
import { readCorrectionsJournal, readCorrectionsJournalSafe } from './corrections'
import { purgeBrain } from './store'

const ERASED_AT = Date.UTC(2026, 9, 24, 12, 0, 0)
const entryAt = (ms: number) => ({
  seq: 0,
  at: new Date(ms).toISOString(),
  kind: 'commitment_reject',
  payload: { personSlug: 'p', dealSlug: 'd', text: 'synthetic' }
})

describe('corrections conflict copy after erasure (G82)', () => {
  let folder: string
  let userData: string
  let s: Settings

  beforeEach(async () => {
    useStorageForTests()
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-corrections-fence-')))
    userData = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-fence-userdata-')))
    s = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    const fence = createErasureFence(erasureFenceFile(userData))
    await fence.record('legacy', 'c'.repeat(32), ERASED_AT)
    configureErasureFence(fence)
    mkdirSync(brainDir(s), { recursive: true })
  })
  afterEach(() => {
    configureErasureFence(null)
    rmSync(folder, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  const plant = (name: string, entryMs: number): void =>
    writeFileSync(join(brainDir(s), name), JSON.stringify([entryAt(entryMs)]))

  it('a conflict copy holding corrections made before the erasure is not merged back', async () => {
    plant('corrections-DESKTOP-ABC.json', ERASED_AT - 3_600_000)
    expect(readCorrectionsJournal(s)).toEqual([])
    const gate = await readCorrectionsJournalSafe(s)
    expect(gate.ok).toBe(true)
    expect(gate.entries).toEqual([])
  })

  it('a conflict copy holding a correction made after the erasure is still merged', () => {
    plant('corrections-DESKTOP-ABC.json', ERASED_AT + 3_600_000)
    expect(readCorrectionsJournal(s)).toHaveLength(1)
  })

  it('an erase never restores an escrowed journal: only a rebuild keeps human files', () => {
    plant('corrections.json', ERASED_AT - 3_600_000)
    writeFileSync(`${brainDir(s)}.corrections-preserve.json`, JSON.stringify([entryAt(ERASED_AT - 3_600_000)]))
    expect(purgeBrain(s, { mode: 'erase' }).ok).toBe(true)
    expect(existsSync(brainDir(s))).toBe(false) // nothing was copied back from the escrow
  })
})
