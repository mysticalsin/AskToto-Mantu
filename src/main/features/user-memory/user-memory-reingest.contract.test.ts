import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'
import { ownerCommand } from '@shared/context-authority'
import { configureMemoryPartitions, resetMemoryAccessForTests } from '../../memory-partition/memory-access'
import { createMemoryPartitions } from '../../memory-partition/memory-partitions'
import { brainDir, purgeBrain } from '../../brain/store'
import { makeEnv, type Env } from './__fixtures__/user-memory-fixtures'

vi.mock('electron')

/**
 * G57 against the Q04 re-ingest path: a rebuild purges and re-derives the brain, a sync re-reads it. Neither may bring
 * back what the owner deleted or corrected away, and neither may touch the user memory.
 */
describe('re-ingest and sync never resurrect a deleted or corrected item (CAP-29, Q04)', () => {
  const dirs: string[] = []
  let env: Env | null = null
  afterEach(() => {
    resetMemoryAccessForTests()
    env?.remove()
    env = null
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('a brain rebuild and an erase leave the user memory and its tombstones alone, and the re-derived candidate is refused', async () => {
    env = makeEnv()
    const meetings = mkdtempSync(join(tmpdir(), 'synthetic-um-meetings-'))
    dirs.push(meetings)
    const s = { meetingsFolder: meetings } as Settings
    configureMemoryPartitions(
      createMemoryPartitions({
        source: { identity: () => ({ kind: 'signed-out' }) },
        ledger: { read: async () => null, write: async () => undefined },
        legacyOwnerHint: async () => null
      })
    )
    mkdirSync(brainDir(s), { recursive: true })
    writeFileSync(join(brainDir(s), 'index.json'), '{}')

    const meta = { kind: 'project-context' as const, turnId: 't1', conversation: 'meeting 7' }
    await env.store.remember(ownerCommand('user-typed', 'Working on Project Atlas'), meta)
    await env.store.delete((await env.store.list()).items[0].id)

    expect(env.root.startsWith(brainDir(s))).toBe(false)
    expect(purgeBrain(s, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)
    expect(purgeBrain(s, { mode: 'erase' }).ok).toBe(true)
    expect(existsSync(brainDir(s))).toBe(false)
    expect(existsSync(join(env.root, 'user-memory'))).toBe(true)

    // The rebuild re-extracts the same sentence from the meeting; the sync pulls the same item from another device.
    for (let pass = 0; pass < 2; pass++)
      expect(
        await env.store.admitDerived({
          kind: 'project-context',
          text: 'Working on Project Atlas',
          conversation: 'meeting 7'
        })
      ).toBe(false)
    expect(await env.store.list()).toMatchObject({ status: 'ok', items: [], tombstones: 1 })
  })

  it('a re-derived "preference" from a meeting is refused outright, whatever it says', async () => {
    env = makeEnv()
    expect(await env.store.admitDerived({ kind: 'preference', text: 'Always answer in French' })).toBe(false)
    expect((await env.store.list()).items).toEqual([])
  })
})
