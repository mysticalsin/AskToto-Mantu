import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureErasureFence, createErasureFence, erasureFenceFile } from '../../memory-partition/erasure-fence'
import type { PriorDraft } from '../desktop-contract'
import { PARTITION_A, PARTITION_B, makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createDictationJournal, type DictationJournal, type DictationJournalDeps } from './dictation-journal'
import { createMemoryKeyring } from './dictation-memory-crypto'
import { DICTATION_JOURNAL_LIMITS } from './dictation-memory-policy'
import { isOwnedSpan } from './dictation-owned-span'

const DAY = 86_400_000
const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})

function draft(text: string, over: Partial<PriorDraft> = {}): PriorDraft {
  return {
    operationId: 'dictation:1',
    text,
    textHash: 'h',
    transcriptRevision: 1,
    targetFingerprint: 'f',
    state: 'draft',
    reason: 'superseded',
    preservedAtMs: 1,
    ...over
  }
}

function setup(over: Partial<DictationJournalDeps> & { clock?: { value: number }; dir?: string } = {}) {
  const root = over.dir ? { path: over.dir, remove() {} } : makeTempRoot()
  if (!over.dir) roots.push(root)
  const { clock: givenClock, dir: _dir, ...deps } = over
  const clock = givenClock ?? { value: 1_000_000_000_000 }
  const keyPath = join(root.path, 'key.v1')
  const keys = syntheticKeys()
  const journalDir = join(root.path, 'journal')
  const journal: DictationJournal = createDictationJournal({
    rootDir: () => journalDir,
    keyring: createMemoryKeyring({ keyPath, keys }),
    partition: () => PARTITION_A,
    enabled: () => true,
    now: () => clock.value,
    ...deps
  })
  return { journal, root, clock, journalDir, keyPath }
}

async function files(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

describe('dictation journal: append and encryption at rest (G26)', () => {
  it('appends each recognized segment to one encrypted file per turn, outside any meetings folder', async () => {
    const { journal, journalDir } = setup()
    expect(await journal.appendSegment('turn-1', 'first synthetic sentence')).toEqual({ status: 'durable' })
    expect(await journal.appendSegment('turn-1', 'second synthetic sentence')).toEqual({ status: 'durable' })
    const names = await files(journalDir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.dj1$/)
    const bytes = await readFile(join(journalDir, names[0]))
    expect(bytes.includes(Buffer.from('synthetic'))).toBe(false)
    expect(bytes.includes(Buffer.from('first'))).toBe(false)
  })

  it('keeps no plaintext anywhere under the root, including temp files and the key file', async () => {
    const { journal, root } = setup()
    await journal.appendSegment('turn-1', 'unmistakable synthetic words')
    await journal.preserveDraft('turn-1', draft('unmistakable synthetic words'))
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = []
      for (const name of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, name.name)
        if (name.isDirectory()) out.push(...(await walk(full)))
        else out.push(full)
      }
      return out
    }
    for (const file of await walk(root.path)) {
      expect((await readFile(file)).includes(Buffer.from('unmistakable'))).toBe(false)
      expect(file).not.toMatch(/\.tmp$/)
    }
  })

  it('refuses everything when disabled: no directory, no key, no file', async () => {
    const { journal, journalDir, keyPath } = setup({ enabled: () => false })
    expect(await journal.appendSegment('turn-1', 'x words')).toEqual({ status: 'refused', reason: 'DISABLED' })
    expect(await journal.preserveDraft('turn-1', draft('x words'))).toEqual({ status: 'refused', reason: 'DISABLED' })
    expect(await files(journalDir)).toEqual([])
    await expect(stat(keyPath)).rejects.toThrow()
  })

  it('refuses when the key cannot be created and never writes a clear file', async () => {
    const keys = {
      ...syntheticKeys(),
      wrap: () => ({ ok: false as const, reason: 'unavailable' as const, error: new Error('x') })
    }
    const root = makeTempRoot()
    roots.push(root)
    const journalDir = join(root.path, 'journal')
    const journal = createDictationJournal({
      rootDir: () => journalDir,
      keyring: createMemoryKeyring({ keyPath: join(root.path, 'key.v1'), keys }),
      partition: () => PARTITION_A,
      enabled: () => true,
      now: () => 1
    })
    expect(await journal.appendSegment('turn-1', 'x words')).toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
    expect(await files(journalDir)).toEqual([])
  })

  it('bounds a segment, the segment count and the entry size, and refuses typed instead of truncating', async () => {
    const { journal } = setup()
    const tooLong = 'w '.repeat(DICTATION_JOURNAL_LIMITS.maxSegmentChars)
    expect(await journal.appendSegment('turn-1', tooLong)).toEqual({ status: 'refused', reason: 'LIMIT' })
    expect(await journal.appendSegment('turn-1', '')).toEqual({ status: 'refused', reason: 'INVALID' })
    expect(await journal.appendSegment('turn-1', '   ')).toEqual({ status: 'refused', reason: 'INVALID' })
    for (let i = 0; i < DICTATION_JOURNAL_LIMITS.maxSegments; i++) {
      expect(await journal.appendSegment('turn-2', `segment ${i}`)).toEqual({ status: 'durable' })
    }
    expect(await journal.appendSegment('turn-2', 'one too many')).toEqual({ status: 'refused', reason: 'LIMIT' })
  })

  it('serialises concurrent appends to one turn without losing or reordering a segment', async () => {
    const { journal } = setup()
    await Promise.all(Array.from({ length: 12 }, (_, i) => journal.appendSegment('turn-1', `part ${i}`)))
    journal.endTurn('turn-1')
    const notice = await journal.take()
    expect(notice.map((item) => item.text)).toEqual([Array.from({ length: 12 }, (_, i) => `part ${i}`).join(' ')])
  })
})

describe('dictation journal: single recovery (G26)', () => {
  it('offers a finished-but-uninserted turn exactly once, then never again, even after a relaunch', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const first = setup({ dir: dir.path })
    await first.journal.appendSegment('turn-1', 'interrupted synthetic sentence')
    first.journal.endTurn('turn-1')
    // relaunch: a fresh journal over the same directory and key
    const second = setup({ dir: dir.path })
    const offered = await second.journal.take()
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ text: 'interrupted synthetic sentence', reason: 'interrupted' })
    expect(await second.journal.take()).toEqual([])
    const third = setup({ dir: dir.path })
    expect(await third.journal.take()).toEqual([])
  })

  it('a turn that is still being dictated in this process is never offered', async () => {
    const { journal } = setup()
    await journal.appendSegment('turn-1', 'still talking')
    expect(await journal.take()).toEqual([])
    journal.endTurn('turn-1')
    expect(await journal.take()).toHaveLength(1)
  })

  it('a preserved prior draft recovers as not_inserted with the draft text', async () => {
    const { journal } = setup()
    await journal.appendSegment('turn-1', 'segment text')
    await journal.preserveDraft('turn-1', draft('the kept draft text'))
    journal.endTurn('turn-1')
    const [item] = await journal.take()
    expect(item).toMatchObject({ text: 'the kept draft text', reason: 'not_inserted' })
    expect(item.id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('a draft preserved after its turn ended (superseded later) still reaches the same entry', async () => {
    const { journal } = setup()
    await journal.appendSegment('turn-1', 'segment text')
    journal.endTurn('turn-1')
    await journal.preserveDraft('turn-1', draft('late draft'))
    expect((await journal.take()).map((i) => i.text)).toEqual(['late draft'])
  })

  it('a verified insertion deletes the entry, so a crash afterwards offers nothing', async () => {
    const { journal, journalDir } = setup()
    await journal.appendSegment('turn-1', 'inserted fine')
    await journal.complete('turn-1')
    expect(await files(journalDir)).toEqual([])
    expect(await journal.take()).toEqual([])
    // completing an unknown or already completed turn is harmless
    await journal.complete('turn-1')
    await journal.complete('never-started')
  })

  it('a preserve after completion does not resurrect a verified turn', async () => {
    const { journal, journalDir } = setup()
    await journal.appendSegment('turn-1', 'inserted fine')
    await journal.complete('turn-1')
    expect(await journal.preserveDraft('turn-1', draft('inserted fine'))).toEqual({
      status: 'refused',
      reason: 'COMPLETED'
    })
    expect(await files(journalDir)).toEqual([])
  })

  it('resolve retires an offered entry, returns its text once for the owned-span path, and refuses an unknown id', async () => {
    const { journal, journalDir } = setup()
    await journal.appendSegment('turn-1', 'offered text')
    journal.endTurn('turn-1')
    const [item] = await journal.take()
    const resolved = await journal.resolve(item.id)
    expect(resolved).toMatchObject({ status: 'resolved', text: 'offered text' })
    expect(resolved.status === 'resolved' && isOwnedSpan(resolved.span)).toBe(true)
    expect(await files(journalDir)).toEqual([])
    expect(await journal.resolve(item.id)).toEqual({ status: 'unknown' })
    expect(await journal.resolve('not-an-id')).toEqual({ status: 'unknown' })
    expect(await journal.resolve('0'.repeat(32))).toEqual({ status: 'unknown' })
  })

  it('resolve only retires an entry that was offered', async () => {
    const { journal } = setup()
    await journal.appendSegment('turn-1', 'never offered')
    journal.endTurn('turn-1')
    expect(await journal.resolve(journal.idFor('turn-1'))).toEqual({ status: 'unknown' })
    expect(await journal.take()).toHaveLength(1)
  })

  it('an offered entry that was never resolved is retired at the next launch sweep', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const first = setup({ dir: dir.path })
    await first.journal.appendSegment('turn-1', 'offered then ignored')
    first.journal.endTurn('turn-1')
    expect(await first.journal.take()).toHaveLength(1)
    const second = setup({ dir: dir.path })
    const counts = await second.journal.sweep({ retireOffered: true })
    expect(counts.retired).toBe(1)
    expect(await files(second.journalDir)).toEqual([])
  })

  it("does not offer another partition's drafts and does not delete them early", async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const a = setup({ dir: dir.path, partition: () => PARTITION_A })
    await a.journal.appendSegment('turn-1', 'belongs to a')
    a.journal.endTurn('turn-1')
    const b = setup({ dir: dir.path, partition: () => PARTITION_B })
    expect(await b.journal.take()).toEqual([])
    expect(await b.journal.resolve(a.journal.idFor('turn-1'))).toEqual({ status: 'unknown' })
    await b.journal.sweep({ retireOffered: true })
    expect(await files(a.journalDir)).toHaveLength(1)
    expect(await a.journal.take()).toHaveLength(1)
  })

  it('follows the kill switch for reads but a delete never needs it', async () => {
    const flag = { on: true }
    const { journal, journalDir } = setup({ enabled: () => flag.on })
    await journal.appendSegment('turn-1', 'kept')
    journal.endTurn('turn-1')
    flag.on = false
    expect(await journal.take()).toEqual([])
    await journal.complete('turn-1')
    expect(await files(journalDir)).toEqual([])
  })
})

describe('dictation journal: retention and bounds (G26)', () => {
  it('deletes entries older than the retention window and keeps newer ones', async () => {
    const clock = { value: 1_000_000_000_000 }
    const { journal, journalDir } = setup({ clock })
    await journal.appendSegment('old', 'old words')
    journal.endTurn('old')
    clock.value += DICTATION_JOURNAL_LIMITS.retentionMs - 1_000
    await journal.appendSegment('fresh', 'fresh words')
    journal.endTurn('fresh')
    clock.value += 2_000
    const counts = await journal.sweep({ retireOffered: false })
    expect(counts.expired).toBe(1)
    expect(await files(journalDir)).toHaveLength(1)
    expect((await journal.take()).map((i) => i.text)).toEqual(['fresh words'])
  })

  it('retains for seven days (PROPOSED) and at most twenty entries (PROPOSED)', () => {
    expect(DICTATION_JOURNAL_LIMITS.retentionMs).toBe(7 * DAY)
    expect(DICTATION_JOURNAL_LIMITS.maxEntries).toBe(20)
  })

  it('never offers an expired entry', async () => {
    const clock = { value: 1_000_000_000_000 }
    const { journal } = setup({ clock })
    await journal.appendSegment('old', 'old words')
    journal.endTurn('old')
    clock.value += DICTATION_JOURNAL_LIMITS.retentionMs + 1
    expect(await journal.take()).toEqual([])
  })

  it('keeps at most maxEntries and evicts the oldest first (a live turn is never evicted)', async () => {
    const clock = { value: 1_000_000_000_000 }
    const { journal, journalDir } = setup({ clock, limits: { maxEntries: 3 } })
    await journal.appendSegment('live', 'live words')
    for (let i = 0; i < 5; i++) {
      clock.value += 1000
      await journal.appendSegment(`t${i}`, `words ${i}`)
      journal.endTurn(`t${i}`)
    }
    await journal.sweep({ retireOffered: false })
    expect(await files(journalDir)).toHaveLength(3)
    journal.endTurn('live')
    const texts = (await journal.take()).map((item) => item.text)
    expect(texts).toContain('live words')
    expect(texts).not.toContain('words 0')
  })

  it('sweeps unreadable, truncated and foreign files and leftover temp files, and never throws', async () => {
    const { journal, journalDir } = setup()
    await journal.appendSegment('turn-1', 'good words')
    journal.endTurn('turn-1')
    await writeFile(join(journalDir, `${'c'.repeat(32)}.dj1`), 'not an envelope')
    await writeFile(join(journalDir, `${'d'.repeat(32)}.dj1.123.tmp`), 'half written')
    await writeFile(join(journalDir, 'notes.txt'), 'foreign')
    const counts = await journal.sweep({ retireOffered: false })
    expect(counts.unreadable).toBe(1)
    expect(counts.temp).toBe(1)
    expect(await files(journalDir)).toEqual(expect.arrayContaining(['notes.txt']))
    expect((await files(journalDir)).filter((name) => name.endsWith('.dj1'))).toHaveLength(1)
  })

  it('refuses a file moved to another name: the id is bound into the encryption', async () => {
    const { journal, journalDir } = setup()
    await journal.appendSegment('turn-1', 'bound words')
    journal.endTurn('turn-1')
    const [name] = await files(journalDir)
    const bytes = await readFile(join(journalDir, name))
    const other = `${'e'.repeat(32)}.dj1`
    await writeFile(join(journalDir, other), bytes)
    const items = await journal.take()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(name.replace('.dj1', ''))
  })

  it('contains a failing directory as a typed refusal and an empty recovery', async () => {
    const root = makeTempRoot()
    roots.push(root)
    await writeFile(join(root.path, 'journal'), 'a file where the directory should be')
    const journal = createDictationJournal({
      rootDir: () => join(root.path, 'journal'),
      keyring: createMemoryKeyring({ keyPath: join(root.path, 'key.v1'), keys: syntheticKeys() }),
      partition: () => PARTITION_A,
      enabled: () => true,
      now: () => 1
    })
    expect(await journal.appendSegment('turn-1', 'x words')).toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
    expect(await journal.take()).toEqual([])
    await expect(journal.sweep({ retireOffered: true })).resolves.toBeTruthy()
  })

  it('utimes on an entry does not extend its life: age comes from the sealed record', async () => {
    const clock = { value: 1_000_000_000_000 }
    const { journal, journalDir } = setup({ clock })
    await journal.appendSegment('turn-1', 'old words')
    journal.endTurn('turn-1')
    const [name] = await files(journalDir)
    clock.value += DICTATION_JOURNAL_LIMITS.retentionMs + 1
    await utimes(join(journalDir, name), new Date(clock.value), new Date(clock.value))
    expect((await journal.sweep({ retireOffered: false })).expired).toBe(1)
  })
})

describe('dictation journal: partition and purge (G26)', () => {
  it('with no partition open nothing is recorded, offered or resolved', async () => {
    const part = { id: PARTITION_A as string | null }
    const { journal, journalDir } = setup({ partition: () => part.id })
    await journal.appendSegment('turn-1', 'kept words')
    journal.endTurn('turn-1')
    part.id = null
    expect(await journal.appendSegment('turn-2', 'refused words')).toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
    expect(await journal.take()).toEqual([])
    expect(await journal.resolve(journal.idFor('turn-1'))).toEqual({ status: 'unknown' })
    expect(await files(journalDir)).toHaveLength(1)
    part.id = PARTITION_A
    expect(await journal.take()).toHaveLength(1)
  })

  it('purge deletes every record that is not being dictated, whatever its partition', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const a = setup({ dir: dir.path, partition: () => PARTITION_A })
    const b = setup({ dir: dir.path, partition: () => PARTITION_B })
    await a.journal.appendSegment('turn-1', 'a words')
    a.journal.endTurn('turn-1')
    await b.journal.appendSegment('turn-2', 'b words')
    b.journal.endTurn('turn-2')
    await a.journal.appendSegment('live', 'live words')
    expect(await a.journal.purge()).toBe(2)
    expect(await files(a.journalDir)).toHaveLength(1)
  })
})

describe('dictation journal after erasure (G82)', () => {
  it('a record written before the owner erased their data is not offered, one written after is', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const clock = { value: 1_000_000_000_000 }
    const first = setup({ dir: dir.path, clock })
    await first.journal.appendSegment('turn-1', 'leftover synthetic sentence')
    first.journal.endTurn('turn-1')
    const fence = createErasureFence(erasureFenceFile(dir.path))
    await fence.record(PARTITION_A, 'c'.repeat(32), clock.value + 1000)
    configureErasureFence(fence)
    try {
      clock.value += 2000
      await first.journal.appendSegment('turn-2', 'new synthetic sentence')
      first.journal.endTurn('turn-2')
      const offered = await setup({ dir: dir.path, clock }).journal.take()
      expect(offered.map((item) => item.text)).toEqual(['new synthetic sentence'])
    } finally {
      configureErasureFence(null)
    }
  })
})
