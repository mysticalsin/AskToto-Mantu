import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PARTITION_A, PARTITION_B, makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createDictationDictionary, type DictationDictionaryDeps } from './dictation-dictionary'
import { createMemoryKeyring } from './dictation-memory-crypto'
import { DICTATION_DICTIONARY_LIMITS } from './dictation-memory-policy'
import { mintOwnedSpan } from './dictation-owned-span'

const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})

function setup(over: Partial<DictationDictionaryDeps> & { dir?: string; clock?: { value: number } } = {}) {
  const root = over.dir ? { path: over.dir, remove() {} } : makeTempRoot()
  if (!over.dir) roots.push(root)
  const clock = over.clock ?? { value: 5_000 }
  const dictionaryDir = join(root.path, 'dictionary')
  const dictionary = createDictationDictionary({
    rootDir: () => dictionaryDir,
    keyring: createMemoryKeyring({ keyPath: join(root.path, 'key.v1'), keys: syntheticKeys() }),
    partition: () => PARTITION_A,
    now: () => clock.value,
    ...over
  })
  return { dictionary, root, dictionaryDir, clock }
}

const span = (text: string) => mintOwnedSpan(text, 'dictation-turn')

describe('personal dictionary: owned-span learning (G26)', () => {
  it('learns term to preferred spelling from a correction of an owned span, and lists it', async () => {
    const { dictionary } = setup()
    expect(await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')).toEqual({
      learned: 1
    })
    const list = await dictionary.list()
    expect(list.status).toBe('ok')
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0]).toMatchObject({ heard: 'tota', preferred: 'Toto', count: 1, updatedAtMs: 5_000 })
    expect(list.entries[0].id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('counts a repeated correction and lets the latest preferred spelling win', async () => {
    const { dictionary, clock } = setup()
    await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')
    clock.value += 10
    await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')
    expect((await dictionary.list()).entries[0]).toMatchObject({ preferred: 'Toto', count: 2, updatedAtMs: 5_010 })
    await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Tota about it now')
    const [entry] = (await dictionary.list()).entries
    expect(entry).toMatchObject({ heard: 'tota', preferred: 'Tota', count: 1 })
  })

  it('refuses a span that main did not mint: a forged object, a string or a plain copy learns nothing', async () => {
    const { dictionary, dictionaryDir } = setup()
    const forged = { text: 'ask tota about it now', origin: 'dictation-turn' } as never
    expect(await dictionary.learnFromCorrection(forged, 'ask Toto about it now')).toEqual({ learned: 0 })
    expect(await dictionary.learnFromCorrection('ask tota about it now' as never, 'ask Toto about it now')).toEqual({
      learned: 0
    })
    expect(
      await dictionary.learnFromCorrection({ ...span('ask tota about it now') } as never, 'ask Toto about it now')
    ).toEqual({
      learned: 0
    })
    await expect(readdir(dictionaryDir)).rejects.toThrow()
  })

  it('learns nothing from an unchanged text or a rewrite', async () => {
    const { dictionary } = setup()
    expect(await dictionary.learnFromCorrection(span('same words here'), 'same words here')).toEqual({ learned: 0 })
    expect(
      await dictionary.learnFromCorrection(
        span('we should meet on tuesday to review it'),
        'completely other sentence about lunch'
      )
    ).toEqual({ learned: 0 })
    expect((await dictionary.list()).entries).toEqual([])
  })

  it('stores entries encrypted at rest under the profile key', async () => {
    const { dictionary, dictionaryDir } = setup()
    await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')
    const [name] = await readdir(dictionaryDir)
    expect(name).toMatch(/^[0-9a-f]{32}\.dd1$/)
    const bytes = await readFile(join(dictionaryDir, name))
    expect(bytes.includes(Buffer.from('Toto'))).toBe(false)
    expect(bytes.includes(Buffer.from('tota'))).toBe(false)
  })

  it('is partitioned: another verified user never sees, changes or clears these entries', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const a = setup({ dir: dir.path, partition: () => PARTITION_A })
    const b = setup({ dir: dir.path, partition: () => PARTITION_B })
    await a.dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')
    expect((await b.dictionary.list()).entries).toEqual([])
    const [entry] = (await a.dictionary.list()).entries
    expect(await b.dictionary.remove(entry.id)).toBe(false)
    expect(await b.dictionary.clear()).toBe(0)
    expect((await a.dictionary.list()).entries).toHaveLength(1)
  })

  it('removes one entry by id and clears all, reporting counts, and a delete needs no span', async () => {
    const { dictionary } = setup()
    await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')
    await dictionary.learnFromCorrection(span('use mantis for notes'), 'use Métis for notes')
    const { entries } = await dictionary.list()
    expect(entries).toHaveLength(2)
    expect(await dictionary.remove(entries[0].id)).toBe(true)
    expect(await dictionary.remove(entries[0].id)).toBe(false)
    expect(await dictionary.remove('nope')).toBe(false)
    expect(await dictionary.clear()).toBe(1)
    expect((await dictionary.list()).entries).toEqual([])
    expect(await dictionary.clear()).toBe(0)
  })

  it('bounds the dictionary and evicts the least recently updated entry first', async () => {
    const { dictionary, clock } = setup({ limits: { maxEntries: 3 } })
    for (let i = 0; i < 5; i++) {
      clock.value += 1
      await dictionary.learnFromCorrection(span(`say word${i} here now ok`), `say Fixed${i} here now ok`)
    }
    const heard = (await dictionary.list()).entries.map((e) => e.heard).sort()
    expect(heard).toEqual(['word2', 'word3', 'word4'])
  })

  it('PROPOSED cap is 500 entries', () => {
    expect(DICTATION_DICTIONARY_LIMITS.maxEntries).toBe(500)
  })

  it('serialises concurrent corrections without losing one', async () => {
    const { dictionary } = setup()
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        dictionary.learnFromCorrection(span(`say word${i} here now ok`), `say Fixed${i} here now ok`)
      )
    )
    expect((await dictionary.list()).entries).toHaveLength(6)
  })

  it('reports unavailable for an unreadable file, never overwrites it, and clear resets it', async () => {
    const { dictionary, dictionaryDir } = setup()
    await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')
    const [name] = await readdir(dictionaryDir)
    await writeFile(join(dictionaryDir, name), 'garbled')
    expect(await dictionary.list()).toEqual({ status: 'unavailable', entries: [] })
    expect(await dictionary.learnFromCorrection(span('use mantis for notes'), 'use Métis for notes')).toEqual({
      learned: 0
    })
    expect(await readFile(join(dictionaryDir, name), 'utf8')).toBe('garbled')
    expect(await dictionary.clear()).toBe(0)
    expect(await dictionary.list()).toEqual({ status: 'ok', entries: [] })
    expect(await dictionary.learnFromCorrection(span('use mantis for notes'), 'use Métis for notes')).toEqual({
      learned: 1
    })
  })

  it('reports unavailable when the key cannot be had and learns nothing', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const keys = {
      ...syntheticKeys(),
      wrap: () => ({ ok: false as const, reason: 'unavailable' as const, error: new Error('x') })
    }
    const dictionary = createDictationDictionary({
      rootDir: () => join(root.path, 'dictionary'),
      keyring: createMemoryKeyring({ keyPath: join(root.path, 'key.v1'), keys }),
      partition: () => PARTITION_A,
      now: () => 1
    })
    expect(await dictionary.learnFromCorrection(span('ask tota about it now'), 'ask Toto about it now')).toEqual({
      learned: 0
    })
    expect((await dictionary.list()).entries).toEqual([])
  })
})
