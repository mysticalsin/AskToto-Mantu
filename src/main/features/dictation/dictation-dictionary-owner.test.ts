import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PARTITION_A, PARTITION_B, makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createDictationDictionary } from './dictation-dictionary'
import { createDictationMemory } from './dictation-memory'
import { createMemoryKeyring, type MemoryKeyring } from './dictation-memory-crypto'
import { mintOwnedSpan } from './dictation-owned-span'

const roots: Array<{ remove(): void }> = []
const keyrings: Array<MemoryKeyring> = []
afterEach(() => {
  while (keyrings.length) keyrings.pop()?.dispose()
  while (roots.length) roots.pop()?.remove()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withOpenBarrier(real: MemoryKeyring) {
  let next: { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | null = null
  let openCalls = 0
  const keyring: MemoryKeyring = {
    seal: (plain, aad) => real.seal(plain, aad),
    async open(sealed, aad) {
      openCalls += 1
      const gate = next
      if (gate) {
        next = null
        gate.started.resolve()
        await gate.released.promise
      }
      return real.open(sealed, aad)
    },
    dispose: () => real.dispose()
  }
  return {
    keyring,
    openCalls: () => openCalls,
    holdNextOpen() {
      if (next) throw new Error('an open is already held')
      const gate = { started: deferred(), released: deferred() }
      next = gate
      return { started: gate.started.promise, release: () => gate.released.resolve() }
    }
  }
}

function dictionaryFixture() {
  const root = makeTempRoot()
  roots.push(root)
  const partition = { value: PARTITION_A as string | null }
  const realKeyring = createMemoryKeyring({
    keyPath: join(root.path, 'key.v1'),
    keys: syntheticKeys()
  })
  const gated = withOpenBarrier(realKeyring)
  keyrings.push(gated.keyring)
  const dictionary = createDictationDictionary({
    rootDir: () => join(root.path, 'dictionary'),
    keyring: gated.keyring,
    partition: () => partition.value,
    now: () => 5_000
  })
  return { root, partition, dictionary, holdNextOpen: gated.holdNextOpen, openCalls: gated.openCalls }
}

async function seedBothPartitions(
  dictionary: ReturnType<typeof createDictationDictionary>,
  partition: { value: string | null }
) {
  expect(
    await dictionary.learnFromCorrection(
      mintOwnedSpan('ask tota about the plan', 'dictation-turn'),
      'ask Toto about the plan'
    )
  ).toEqual({
    learned: 1
  })
  partition.value = PARTITION_B
  expect(
    await dictionary.learnFromCorrection(mintOwnedSpan('use mantis for notes', 'dictation-turn'), 'use Métis for notes')
  ).toEqual({
    learned: 1
  })
  partition.value = PARTITION_A
}

const terms = (entries: Array<{ heard: string; preferred: string }>) =>
  entries.map(({ heard, preferred }) => [heard, preferred])
const unavailable = { status: 'unavailable', entries: [] }

describe('dictation dictionary reads remain bound to the owner generation (G26/G19)', () => {
  it('returns the active owner’s persisted entries on a stable read', async () => {
    const { dictionary, partition } = dictionaryFixture()
    await seedBothPartitions(dictionary, partition)

    const listA = await dictionary.list()
    expect(listA.status).toBe('ok')
    expect(terms(listA.entries)).toEqual([['tota', 'Toto']])

    partition.value = PARTITION_B
    const listB = await dictionary.list()
    expect(listB.status).toBe('ok')
    expect(terms(listB.entries)).toEqual([['mantis', 'Métis']])
  })

  it('refuses a decrypting A read after switching to B and leaves both partitions intact', async () => {
    const { root, dictionary, partition, holdNextOpen } = dictionaryFixture()
    await seedBothPartitions(dictionary, partition)
    const file = join(root.path, 'dictionary', `${PARTITION_A}.dd1`)
    const original = await readFile(file)
    const gate = holdNextOpen()
    const pending = dictionary.list()
    await gate.started
    partition.value = PARTITION_B
    gate.release()

    expect(await pending).toEqual(unavailable)
    expect(await readFile(file)).toEqual(original)
    expect(terms((await dictionary.list()).entries)).toEqual([['mantis', 'Métis']])
    partition.value = PARTITION_A
    expect(terms((await dictionary.list()).entries)).toEqual([['tota', 'Toto']])
  })

  it('refuses a decrypting A read when no owner partition remains and keeps A intact', async () => {
    const { root, dictionary, partition, holdNextOpen } = dictionaryFixture()
    await seedBothPartitions(dictionary, partition)
    const file = join(root.path, 'dictionary', `${PARTITION_A}.dd1`)
    const original = await readFile(file)
    const gate = holdNextOpen()
    const pending = dictionary.list()
    await gate.started
    partition.value = null
    gate.release()

    expect(await pending).toEqual(unavailable)
    expect(await readFile(file)).toEqual(original)
    partition.value = PARTITION_A
    expect(terms((await dictionary.list()).entries)).toEqual([['tota', 'Toto']])
  })

  it('invalidates a queued A read if the owner changes before that read starts', async () => {
    const { root, dictionary, partition, holdNextOpen, openCalls } = dictionaryFixture()
    await seedBothPartitions(dictionary, partition)
    const file = join(root.path, 'dictionary', `${PARTITION_A}.dd1`)
    const original = await readFile(file)
    const callsBeforeRead = openCalls()
    const gate = holdNextOpen()
    const inFlight = dictionary.list()
    await gate.started
    const queued = dictionary.list()
    partition.value = PARTITION_B
    gate.release()

    expect(await inFlight).toEqual(unavailable)
    expect(await queued).toEqual(unavailable)
    expect(openCalls()).toBe(callsBeforeRead + 1)
    expect(await readFile(file)).toEqual(original)
    expect(terms((await dictionary.list()).entries)).toEqual([['mantis', 'Métis']])
    partition.value = PARTITION_A
    expect(terms((await dictionary.list()).entries)).toEqual([['tota', 'Toto']])
  })

  it('invalidates a pending memory API read across revoke and same-partition return (ABA)', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const memoryRoot = join(root.path, 'dictation-memory')
    const keyPath = join(memoryRoot, 'key.v1')
    const seedKeyring = createMemoryKeyring({ keyPath, keys: syntheticKeys() })
    const seedDictionary = createDictationDictionary({
      rootDir: () => join(memoryRoot, 'dictionary'),
      keyring: seedKeyring,
      partition: () => PARTITION_A,
      now: () => 5_000
    })
    await seedDictionary.learnFromCorrection(
      mintOwnedSpan('ask tota about the plan', 'dictation-turn'),
      'ask Toto about the plan'
    )
    seedKeyring.dispose()

    const keys = syntheticKeys()
    const readFile = keys.readFile.bind(keys)
    const started = deferred()
    const released = deferred()
    let holdKeyRead = true
    keys.readFile = async (path) => {
      if (holdKeyRead && path === keyPath) {
        holdKeyRead = false
        started.resolve()
        await released.promise
      }
      return readFile(path)
    }
    const partition = { value: PARTITION_A as string | null }
    const memory = createDictationMemory({
      rootDir: () => memoryRoot,
      keys,
      partition: () => partition.value,
      enabled: () => true,
      now: () => 5_000
    })

    try {
      const pending = memory.dictionaryList()
      await started.promise
      partition.value = null
      memory.onOwnerRevoked()
      partition.value = PARTITION_A
      released.resolve()

      expect(await pending).toEqual(unavailable)
      const current = await memory.dictionaryList()
      expect(current.status).toBe('ok')
      expect(terms(current.entries)).toEqual([['tota', 'Toto']])
    } finally {
      await memory.dispose()
    }
  })

  it('invalidates a pending memory API read when the memory is disposed', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const memoryRoot = join(root.path, 'dictation-memory')
    const keyPath = join(memoryRoot, 'key.v1')
    const seedKeyring = createMemoryKeyring({ keyPath, keys: syntheticKeys() })
    const seedDictionary = createDictationDictionary({
      rootDir: () => join(memoryRoot, 'dictionary'),
      keyring: seedKeyring,
      partition: () => PARTITION_A,
      now: () => 5_000
    })
    await seedDictionary.learnFromCorrection(
      mintOwnedSpan('ask tota about the plan', 'dictation-turn'),
      'ask Toto about the plan'
    )
    seedKeyring.dispose()

    const keys = syntheticKeys()
    const readFile = keys.readFile.bind(keys)
    const started = deferred()
    const released = deferred()
    let holdKeyRead = true
    keys.readFile = async (path) => {
      if (holdKeyRead && path === keyPath) {
        holdKeyRead = false
        started.resolve()
        await released.promise
      }
      return readFile(path)
    }
    const memory = createDictationMemory({
      rootDir: () => memoryRoot,
      keys,
      partition: () => PARTITION_A,
      enabled: () => true,
      now: () => 5_000
    })

    const pending = memory.dictionaryList()
    await started.promise
    await memory.dispose()
    released.resolve()

    expect(await pending).toEqual(unavailable)
  })
})
