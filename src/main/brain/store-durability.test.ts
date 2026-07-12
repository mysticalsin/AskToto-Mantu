import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync as realRmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'

vi.mock('electron')

/**
 * MI-2.5-JOURNAL Fix F + Fix H — durability of two store.ts safety nets under a simulated mid-operation
 * failure: purgeBrain's correction-journal escrow (Fix F) and ensureV1Backup's one-time safety copy
 * (Fix H). Both need a REAL fs failure partway through a multi-step operation, which a plain temp
 * directory can't reproduce deterministically — so `node:fs`'s `rmSync`/`cpSync` are partially mocked
 * here (one-shot, opt-in per test) rather than in the shared brain.test.ts, to avoid destabilizing every
 * other brain test that also exercises the real filesystem through the same module.
 */
let mockRmSyncFailOnce = false
let mockCpSyncFailOnce = false

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      // Really deletes (so the caller ends up in the REALISTIC "root actually got wiped" state), then
      // reports failure — simulating an rmSync call that completes its work but surfaces a late error
      // (or, from the caller's point of view, is indistinguishable from one that failed after doing
      // most/all of its job — the property under test is recovery, not exactly which files survived).
      const result = actual.rmSync(...args)
      if (mockRmSyncFailOnce) {
        mockRmSyncFailOnce = false
        const err = new Error('EPERM: simulated file lock (OneDrive/AV) mid-wipe') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return result
    },
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      if (mockCpSyncFailOnce) {
        mockCpSyncFailOnce = false
        const [, dest] = args
        // Simulate a cpSync that got partway before failing: some bytes landed at `dest`, then it threw
        // (a dataless OneDrive Files-On-Demand placeholder, or an AV lock, mid-copy).
        actual.mkdirSync(dest as string, { recursive: true })
        actual.writeFileSync(join(dest as string, '.partial'), 'incomplete', 'utf8')
        const err = new Error('EIO: simulated partial copy failure') as NodeJS.ErrnoException
        err.code = 'EIO'
        throw err
      }
      return actual.cpSync(...args)
    }
  }
})

// Imported AFTER the mock factory is declared (vi.mock is hoisted above this regardless of source order).
const { purgeBrain, brainDir, readPerson, writePerson } = await import('./store')

describe('purgeBrain — escrow recovery on a failed wipe (Fix F)', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-purge-escrow-'))
    s = { meetingsFolder: folder } as Settings
    mockRmSyncFailOnce = false
    mockCpSyncFailOnce = false
  })
  afterEach(() => {
    mockRmSyncFailOnce = false
    mockCpSyncFailOnce = false
    realRmSync(folder, { recursive: true, force: true })
  })

  it('restores the journal into root when the wipe fails partway, never leaving it recoverable ONLY under the escrow name', async () => {
    const dir = join(brainDir(s), 'entities', 'person')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'someone.json'),
      JSON.stringify({ schema_version: 2, id: 'someone', name: 'Someone', meetings: [], quotes: [], stance_trail: [], commitments: [], aliases: [] }),
      'utf8'
    )
    const journalContent = [
      { seq: 0, at: '2026-01-01T00:00:00.000Z', kind: 'entity_rename', payload: { kind: 'person', id: 'someone', newName: 'Someone Else' } }
    ]
    writeFileSync(join(brainDir(s), 'corrections.json'), JSON.stringify(journalContent), 'utf8')

    mockRmSyncFailOnce = true
    const r = purgeBrain(s, { preserveCorrections: true })

    expect(r.ok).toBe(false) // the wipe genuinely failed — caller must abort, not assume success

    const journalPath = join(brainDir(s), 'corrections.json')
    const escrowPath = `${brainDir(s)}.corrections-preserve.json`
    expect(existsSync(journalPath)).toBe(true) // never left recoverable ONLY under the escrow name
    expect(existsSync(escrowPath)).toBe(false) // escrow copy cleaned up once restored, not orphaned

    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    expect(journal).toHaveLength(1)
    expect(journal[0].payload.newName).toBe('Someone Else')
  })

  it('purgeBrain still succeeds normally when nothing fails', () => {
    const dir = join(brainDir(s), 'entities', 'person')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'someone.json'), '{}', 'utf8')
    const r = purgeBrain(s)
    expect(r.ok).toBe(true)
    expect(existsSync(brainDir(s))).toBe(false)
  })
})

describe('ensureV1Backup — retry after a failed cpSync, no partial dir mistaken for complete (Fix H)', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-backup-retry-'))
    s = { meetingsFolder: folder } as Settings
    mockRmSyncFailOnce = false
    mockCpSyncFailOnce = false
  })
  afterEach(() => {
    mockRmSyncFailOnce = false
    mockCpSyncFailOnce = false
    realRmSync(folder, { recursive: true, force: true })
  })

  it('does not memoize a failed backup attempt, leaves no partial dir at the final name, and retries on the next write', async () => {
    const dir = join(brainDir(s), 'entities', 'person')
    mkdirSync(dir, { recursive: true })
    const v1RetryRaw = JSON.stringify({
      name: 'Retry Test', role: null, account: null, meetings: [], quotes: [], stance_trail: [], commitments: []
    })
    writeFileSync(join(dir, 'retry-test.json'), v1RetryRaw, 'utf8')
    // A second, untouched v1 file — keeps brainHasV1Entities() true across BOTH write attempts below, so
    // the test isolates ensureV1Backup's own retry bookkeeping from "nothing left to back up".
    writeFileSync(
      join(dir, 'other-v1.json'),
      JSON.stringify({ name: 'Other', role: null, account: null, meetings: [], quotes: [], stance_trail: [], commitments: [] }),
      'utf8'
    )

    const backupDir = `${brainDir(s)}.backup-v1`

    mockCpSyncFailOnce = true
    const migrated = readPerson(s, 'retry-test')!
    await writePerson(s, 'retry-test', migrated) // first v2 write — backup attempt fails (mocked cpSync throw)

    expect(existsSync(backupDir)).toBe(false) // no half-copied dir left behind, mistaken for "done"
    // No orphaned tmp copy left behind either.
    const siblingLeftovers = readdirSync(folder).filter((f) => f.includes('.backup-v1.tmp-'))
    expect(siblingLeftovers).toHaveLength(0)

    const again = readPerson(s, 'retry-test')!
    again.role = 'second write'
    await writePerson(s, 'retry-test', again) // second v2 write — must retry, not permanently skip

    expect(existsSync(backupDir)).toBe(true)
    const backedUpOther = JSON.parse(readFileSync(join(backupDir, 'entities', 'person', 'other-v1.json'), 'utf8'))
    expect(backedUpOther.name).toBe('Other') // the still-v1 file got captured once the retry succeeded
  })
})
