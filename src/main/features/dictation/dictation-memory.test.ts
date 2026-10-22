import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DictationRecoveryNoticeSchema } from '@shared/dictation-memory'
import type { PriorDraft } from '../desktop-contract'
import { PARTITION_A, PARTITION_B, makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createDictationMemory, type DictationMemory, type DictationMemoryDeps } from './dictation-memory'
import { readModuleSource } from '../../../test-helpers/module-source'

const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})

const draft = (text: string): PriorDraft => ({
  operationId: 'dictation:1',
  text,
  textHash: 'h',
  transcriptRevision: 1,
  targetFingerprint: 'f',
  state: 'draft',
  reason: 'superseded',
  preservedAtMs: 1
})

function setup(over: Partial<DictationMemoryDeps> & { dir?: string; clock?: { value: number } } = {}) {
  const root = over.dir ? { path: over.dir, remove() {} } : makeTempRoot()
  if (!over.dir) roots.push(root)
  const clock = over.clock ?? { value: 1_000_000 }
  const audits: Array<Record<string, unknown>> = []
  let n = 0
  const memory: DictationMemory = createDictationMemory({
    rootDir: () => join(root.path, 'dictation-memory'),
    keys: syntheticKeys(),
    partition: () => PARTITION_A,
    enabled: () => true,
    now: () => clock.value,
    newId: () => (++n).toString(16).padStart(32, '0'),
    audit: (record) => audits.push({ ...record }),
    ...over
  })
  return { memory, audits, clock, root }
}

/** Lets the fire-and-forget sink writes land. */
const settle = (memory: DictationMemory) => memory.flush()

describe('dictation memory: the session sink and single recovery (G26)', () => {
  it('journals a recognized segment, deletes it on a verified insertion and offers nothing afterwards', async () => {
    const { memory, root } = setup()
    memory.sink.segmentRecognized('turn-1', 'synthetic recognized words')
    await settle(memory)
    expect(await readdir(join(root.path, 'dictation-memory', 'journal'))).toHaveLength(1)
    memory.sink.inserted('turn-1', 'synthetic recognized words')
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    expect(await readdir(join(root.path, 'dictation-memory', 'journal'))).toEqual([])
    expect(await memory.recoveryTake()).toBeNull()
  })

  it('after a crash it offers the uninserted draft exactly once as a typed notice that is never auto-inserted', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const first = setup({ dir: dir.path })
    first.memory.sink.segmentRecognized('turn-1', 'words that never landed')
    first.memory.sink.draftPreserved('turn-1', draft('words that never landed'))
    await settle(first.memory)
    // the process dies here. Relaunch:
    const second = setup({ dir: dir.path })
    await second.memory.launch()
    const notice = await second.memory.recoveryTake()
    expect(DictationRecoveryNoticeSchema.safeParse(notice).success).toBe(true)
    expect(notice).toMatchObject({ v: 1, kind: 'dictation-recovery', autoInsert: false })
    expect(notice!.items).toHaveLength(1)
    expect(notice!.items[0]).toMatchObject({ text: 'words that never landed', reason: 'not_inserted' })
    expect(await second.memory.recoveryTake()).toBeNull()
    const third = setup({ dir: dir.path })
    await third.memory.launch()
    expect(await third.memory.recoveryTake()).toBeNull()
  })

  it("the preserved prior draft of an earlier turn is appended to that turn's entry", async () => {
    const { memory } = setup()
    memory.sink.segmentRecognized('turn-1', 'first words')
    memory.sink.turnEnded('turn-1')
    memory.sink.segmentRecognized('turn-2', 'second words')
    memory.sink.draftPreserved('turn-1', draft('first words kept'))
    memory.sink.turnEnded('turn-2')
    await settle(memory)
    const notice = await memory.recoveryTake()
    expect(notice!.items.map((i) => i.text).sort()).toEqual(['first words kept', 'second words'])
  })

  it('a sink call never throws and never rejects, even when the store is unavailable', async () => {
    const { memory } = setup({ enabled: () => false })
    expect(() => memory.sink.segmentRecognized('turn-1', 'x words')).not.toThrow()
    expect(() => memory.sink.draftPreserved('turn-1', draft('x words'))).not.toThrow()
    expect(() => memory.sink.inserted('turn-1', 'x words')).not.toThrow()
    expect(() => memory.sink.turnEnded('turn-1')).not.toThrow()
    await expect(settle(memory)).resolves.toBeUndefined()
  })

  it('resolving a draft retires it and acknowledges with counts only', async () => {
    const { memory } = setup()
    memory.sink.segmentRecognized('turn-1', 'draft words')
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    const notice = await memory.recoveryTake()
    const id = notice!.items[0].id
    expect(await memory.recoveryResolve({ id })).toEqual({ ok: true, count: 0 })
    expect(await memory.recoveryResolve({ id })).toEqual({ ok: false, count: 0 })
  })

  it("does not offer another partition's draft", async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const a = setup({ dir: dir.path, partition: () => PARTITION_A })
    a.memory.sink.segmentRecognized('turn-1', 'a words')
    a.memory.sink.turnEnded('turn-1')
    await settle(a.memory)
    const b = setup({ dir: dir.path, partition: () => PARTITION_B })
    expect(await b.memory.recoveryTake()).toBeNull()
  })
})

describe('dictation memory: the dictionary learns only from the owned span (G26)', () => {
  it("learns from a recovered draft the person corrected inside Métis, from main's own copy of the original", async () => {
    const { memory, audits } = setup()
    memory.sink.segmentRecognized('turn-1', 'please ask tota about the plan')
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    const [item] = (await memory.recoveryTake())!.items
    const ack = await memory.recoveryResolve({ id: item.id, correctedText: 'please ask Toto about the plan' })
    expect(ack).toEqual({ ok: true, count: 1 })
    const list = await memory.dictionaryList()
    expect(list.entries.map((e) => [e.heard, e.preferred])).toEqual([['tota', 'Toto']])
    expect(audits.some((a) => a.phase === 'dictionary_learned' && a.count === 1)).toBe(true)
  })

  it('learns from a dictated span corrected inside the twenty second window, once', async () => {
    const { memory, clock } = setup()
    memory.sink.segmentRecognized('turn-1', 'ask tota about the plan')
    memory.sink.inserted('turn-1', 'ask tota about the plan')
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    const { spans } = memory.spansRecent()
    expect(spans).toHaveLength(1)
    clock.value += 5_000
    expect(await memory.spansCorrect({ id: spans[0].id, correctedText: 'ask Toto about the plan' })).toEqual({
      ok: true,
      count: 1
    })
    expect(await memory.spansCorrect({ id: spans[0].id, correctedText: 'ask Toto about the plan' })).toEqual({
      ok: false,
      count: 0
    })
    expect((await memory.dictionaryList()).entries).toHaveLength(1)
  })

  it('learns nothing once the correction window has closed', async () => {
    const { memory, clock } = setup()
    memory.sink.inserted('turn-1', 'ask tota about the plan')
    const id = memory.spansRecent().spans[0].id
    clock.value += 20_001
    expect(await memory.spansCorrect({ id, correctedText: 'ask Toto about the plan' })).toEqual({ ok: false, count: 0 })
    expect((await memory.dictionaryList()).entries).toEqual([])
  })

  it('an id that main did not mint, or a draft that was never offered, learns nothing', async () => {
    const { memory } = setup()
    memory.sink.segmentRecognized('turn-1', 'ask tota about the plan')
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    expect(await memory.spansCorrect({ id: 'f'.repeat(32), correctedText: 'ask Toto about the plan' })).toEqual({
      ok: false,
      count: 0
    })
    expect(await memory.recoveryResolve({ id: 'f'.repeat(32), correctedText: 'ask Toto about the plan' })).toEqual({
      ok: false,
      count: 0
    })
    expect((await memory.dictionaryList()).entries).toEqual([])
  })

  it('a correction that is only an edit (a rewrite) is acknowledged but learns nothing', async () => {
    const { memory } = setup()
    memory.sink.inserted('turn-1', 'we should meet on tuesday to review it')
    const id = memory.spansRecent().spans[0].id
    expect(await memory.spansCorrect({ id, correctedText: 'completely other sentence about lunch' })).toEqual({
      ok: true,
      count: 0
    })
  })

  it("forgets the correction window on sign-out so another user cannot correct the previous user's span", async () => {
    const { memory } = setup()
    memory.sink.inserted('turn-1', 'ask tota about the plan')
    memory.onOwnerRevoked()
    expect(memory.spansRecent().spans).toEqual([])
  })

  it('the dictionary is reachable for learning only through the owned-span path: no module feeds it meeting or screen text', () => {
    for (const spec of [
      './dictation-memory',
      './dictation-dictionary',
      './dictation-owned-span',
      './dictation-journal'
    ]) {
      const text = readModuleSource(__dirname, spec).text
      expect(text, spec).not.toMatch(/from '(\.\.\/)+(\.\.\/)?(meetings|transcripts|speaker|screen|brain|recall|live-)/)
      expect(text, spec).not.toMatch(/screen-observation|transcript-ledger|session-context/)
    }
    const dictionary = readModuleSource(__dirname, './dictation-dictionary').text
    expect(dictionary).toMatch(/isOwnedSpan\(/)
    expect(dictionary).not.toMatch(/export (async )?function learn(?!FromCorrection)/)
    const barrel = readModuleSource(__dirname, './index').text
    expect(barrel).not.toMatch(/mintOwnedSpan/)
  })

  it('deleting is item by item and wholesale, and audits counts', async () => {
    const { memory, audits } = setup()
    for (const [id, a, b] of [
      ['turn-1', 'ask tota about it now', 'ask Toto about it now'],
      ['turn-2', 'use mantis for notes', 'use Métis for notes']
    ]) {
      memory.sink.inserted(id, a)
      const span = memory.spansRecent().spans[0]
      await memory.spansCorrect({ id: span.id, correctedText: b })
    }
    const { entries } = await memory.dictionaryList()
    expect(entries).toHaveLength(2)
    expect(await memory.dictionaryRemove({ id: entries[0].id })).toEqual({ ok: true, count: 1 })
    expect(await memory.dictionaryClear()).toEqual({ ok: true, count: 1 })
    expect(audits.filter((a) => a.phase === 'dictionary_removed' || a.phase === 'dictionary_cleared')).toEqual([
      { phase: 'dictionary_removed', count: 1 },
      { phase: 'dictionary_cleared', count: 1 }
    ])
  })
})

describe('dictation memory: audit carries counts only (G26)', () => {
  it('no audit record ever contains dictated text, a term, a path or an id', async () => {
    const { memory, audits, root } = setup()
    const secret = 'zebra-quartz-unmistakable'
    memory.sink.segmentRecognized('turn-1', `ask ${secret} about the plan`)
    memory.sink.draftPreserved('turn-1', draft(`ask ${secret} about the plan`))
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    const [item] = (await memory.recoveryTake())!.items
    await memory.recoveryResolve({ id: item.id, correctedText: `ask Zebra about the plan` })
    memory.sink.inserted('turn-2', `ask ${secret} again today`)
    await memory.dictionaryClear()
    await memory.launch()
    expect(audits.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(audits)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('Zebra')
    expect(serialized).not.toContain(root.path)
    expect(serialized).not.toContain(item.id)
    for (const record of audits) {
      for (const [key, value] of Object.entries(record)) {
        if (key === 'phase' || key === 'reason') expect(value).toMatch(/^[a-z_]+$/)
        else expect(typeof value).toBe('number')
      }
    }
  })
})

describe('dictation memory: policy gates (G26)', () => {
  it('does not learn while dictated text is not allowed, but inspect and delete still work', async () => {
    const flag = { on: true }
    const { memory } = setup({ enabled: () => flag.on })
    memory.sink.inserted('turn-1', 'ask tota about the plan')
    const id = memory.spansRecent().spans[0].id
    await memory.spansCorrect({ id, correctedText: 'ask Toto about the plan' })
    expect((await memory.dictionaryList()).entries).toHaveLength(1)
    flag.on = false
    memory.sink.inserted('turn-2', 'use mantis for notes')
    expect(memory.spansRecent().spans).toEqual([])
    expect((await memory.dictionaryList()).entries).toHaveLength(1)
    expect(await memory.dictionaryClear()).toEqual({ ok: true, count: 1 })
  })

  it('a denied at-rest policy purges the journal and the dictionary at launch; unknown deletes nothing', async () => {
    const policy = { value: 'allowed' as 'allowed' | 'denied' | 'unknown' }
    const { memory, root, audits } = setup({ atRest: () => policy.value })
    memory.sink.segmentRecognized('turn-1', 'words')
    memory.sink.turnEnded('turn-1')
    await settle(memory)
    memory.sink.inserted('turn-0', 'ask tota about the plan')
    await memory.spansCorrect({ id: memory.spansRecent().spans[0].id, correctedText: 'ask Toto about the plan' })
    policy.value = 'unknown'
    await memory.launch()
    expect(await readdir(join(root.path, 'dictation-memory', 'journal'))).toHaveLength(1)
    policy.value = 'denied'
    await memory.launch()
    expect(await readdir(join(root.path, 'dictation-memory', 'journal'))).toEqual([])
    expect((await memory.dictionaryList()).entries).toEqual([])
    expect(audits.at(-1)).toEqual({ phase: 'text_purged', count: 2 })
  })
})
