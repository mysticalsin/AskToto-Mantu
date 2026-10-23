import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PARTITION_A, PARTITION_B, makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createDictationDictionary, type DictationDictionary } from './dictation-dictionary'
import { createDictationMemory, type DictationMemory, type DictationMemoryAuditRecord } from './dictation-memory'
import { createMemoryKeyring, type MemoryKeyring } from './dictation-memory-crypto'
import { mintOwnedSpan } from './dictation-owned-span'
import { withPathLane } from '../../infra/storage/path-lane'

const roots: Array<{ path: string; remove(): void }> = []
const keyrings: MemoryKeyring[] = []
const memories: DictationMemory[] = []
afterEach(async () => {
  while (memories.length) await memories.pop()?.dispose()
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

async function waitForBarrier<T>(started: Promise<void>, operation: Promise<T>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    started.then(() => 'started' as const),
    operation.then(
      () => 'completed' as const,
      () => 'completed' as const
    ),
    new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), 1_500)
    })
  ])
  if (timeout) clearTimeout(timeout)
  expect(outcome).toBe('started')
}

async function releaseAfterBarrier<T>(
  started: Promise<void>,
  operation: Promise<T>,
  release: () => void,
  onStarted: () => void
): Promise<T> {
  let failure: unknown
  try {
    await waitForBarrier(started, operation)
    onStarted()
  } catch (error) {
    failure = error
  } finally {
    release()
  }

  let result: T | undefined
  try {
    result = await operation
  } catch (error) {
    if (!failure) failure = error
  }
  if (failure) throw failure
  return result as T
}

type Barrier = { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }
function withKeyringBarriers(real: MemoryKeyring) {
  let nextOpen: Barrier | null = null
  let nextSeal: Barrier | null = null
  let openCalls = 0
  const keyring: MemoryKeyring = {
    async seal(plain, aad) {
      const gate = nextSeal
      if (gate) {
        nextSeal = null
        gate.started.resolve()
        await gate.released.promise
      }
      return real.seal(plain, aad)
    },
    async open(sealed, aad) {
      openCalls += 1
      const gate = nextOpen
      if (gate) {
        nextOpen = null
        gate.started.resolve()
        await gate.released.promise
      }
      return real.open(sealed, aad)
    },
    dispose: () => real.dispose()
  }
  const hold = (which: 'open' | 'seal'): { started: Promise<void>; release(): void } => {
    const gate = { started: deferred(), released: deferred() }
    if (which === 'open') {
      if (nextOpen) throw new Error('an open is already held')
      nextOpen = gate
    } else {
      if (nextSeal) throw new Error('a seal is already held')
      nextSeal = gate
    }
    return { started: gate.started.promise, release: () => gate.released.resolve() }
  }
  return { keyring, holdOpen: () => hold('open'), holdSeal: () => hold('seal'), openCalls: () => openCalls }
}

const A_TEXT = 'please ask tota about the plan'
const A_CORRECTED = 'please ask Toto about the plan'
const B_TEXT = 'use mantis for notes'
const B_CORRECTED = 'use Métis for notes'
const aSpan = () => mintOwnedSpan(A_TEXT, 'dictation-turn')
const bSpan = () => mintOwnedSpan(B_TEXT, 'dictation-turn')
const terms = (entries: Array<{ heard: string; preferred: string }>) =>
  entries.map(({ heard, preferred }) => [heard, preferred])
const REFUSED = { ok: false, count: 0 }

function directFixture() {
  const root = makeTempRoot()
  roots.push(root)
  const partition = { value: PARTITION_A as string | null }
  const epoch = { value: 0 }
  const real = createMemoryKeyring({ keyPath: join(root.path, 'key.v1'), keys: syntheticKeys() })
  const gated = withKeyringBarriers(real)
  keyrings.push(gated.keyring)
  const dictionary = createDictationDictionary({
    rootDir: () => join(root.path, 'dictionary'),
    keyring: gated.keyring,
    partition: () => partition.value,
    ownerEpoch: () => epoch.value,
    now: () => 5_000
  })
  return {
    root,
    partition,
    epoch,
    dictionary,
    holdOpen: gated.holdOpen,
    holdSeal: gated.holdSeal,
    openCalls: gated.openCalls,
    file: (owner: string) => join(root.path, 'dictionary', `${owner}.dd1`)
  }
}

async function seedBoth(dictionary: DictationDictionary, partition: { value: string | null }) {
  expect(await dictionary.learnFromCorrection(aSpan(), A_CORRECTED)).toEqual({ learned: 1 })
  partition.value = PARTITION_B
  expect(await dictionary.learnFromCorrection(bSpan(), B_CORRECTED)).toEqual({ learned: 1 })
  partition.value = PARTITION_A
  const entries = await dictionary.list()
  if (entries.status !== 'ok') throw new Error('expected stable owner dictionary')
  const a = entries.entries.find((entry) => entry.heard === 'tota')
  if (!a) throw new Error('expected seeded A term')
  return a.id
}

async function mutate(
  dictionary: DictationDictionary,
  operation: 'learn' | 'remove' | 'clear',
  id: string
): Promise<{ learned: number } | boolean | number> {
  if (operation === 'learn')
    return dictionary.learnFromCorrection(
      mintOwnedSpan('ask toto after lunch', 'dictation-turn'),
      'ask Totó after lunch'
    )
  if (operation === 'remove') return dictionary.remove(id)
  return dictionary.clear()
}

async function readMaybe(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function seedMemoryDictionary(root: { path: string }): Promise<{ id: string; bytes: Buffer; path: string }> {
  const keyring = createMemoryKeyring({ keyPath: join(root.path, 'key.v1'), keys: syntheticKeys() })
  keyrings.push(keyring)
  const dictionary = createDictationDictionary({
    rootDir: () => join(root.path, 'dictionary'),
    keyring,
    partition: () => PARTITION_A,
    now: () => 5_000
  })
  expect(await dictionary.learnFromCorrection(aSpan(), A_CORRECTED)).toEqual({ learned: 1 })
  const listed = await dictionary.list()
  if (listed.status !== 'ok' || listed.entries.length !== 1) throw new Error('expected seeded memory dictionary')
  const path = join(root.path, 'dictionary', `${PARTITION_A}.dd1`)
  return { id: listed.entries[0]!.id, bytes: await readFile(path), path }
}

function memoryFixture(
  root: { path: string },
  partition: { value: string | null },
  options: {
    enabled?: () => boolean
    audit?: (record: DictationMemoryAuditRecord) => void
    holdKeyRead?: boolean
  } = {}
) {
  const keys = syntheticKeys()
  const readWrappedKey = keys.readFile.bind(keys)
  const keyPath = join(root.path, 'key.v1')
  const started = deferred()
  const released = deferred()
  let holdKeyRead = options.holdKeyRead ?? false
  keys.readFile = async (path) => {
    if (path === keyPath && holdKeyRead) {
      holdKeyRead = false
      started.resolve()
      await released.promise
    }
    return readWrappedKey(path)
  }
  const audits: DictationMemoryAuditRecord[] = []
  let memory!: DictationMemory
  memory = createDictationMemory({
    rootDir: () => root.path,
    keys,
    partition: () => partition.value,
    enabled: options.enabled ?? (() => true),
    now: () => 5_000,
    audit: (record) => {
      audits.push({ ...record })
      options.audit?.(record)
    }
  })
  memories.push(memory)
  return { memory, audits, started: started.promise, release: () => released.resolve() }
}

describe('dictation dictionary mutations remain bound to the captured owner generation (G26/G19)', () => {
  it('preserves stable-owner learn, remove and clear behavior', async () => {
    const ctx = directFixture()
    const id = await seedBoth(ctx.dictionary, ctx.partition)
    expect(
      await ctx.dictionary.learnFromCorrection(
        mintOwnedSpan('ask tota before lunch', 'dictation-turn'),
        'ask Toto before lunch'
      )
    ).toEqual({
      learned: 1
    })
    expect(await ctx.dictionary.remove(id)).toBe(true)
    expect((await ctx.dictionary.list()).entries).toEqual([])
    expect(await ctx.dictionary.learnFromCorrection(bSpan(), B_CORRECTED)).toEqual({ learned: 1 })
    expect(await ctx.dictionary.clear()).toBe(1)
    expect((await ctx.dictionary.list()).entries).toEqual([])
  })

  it.each([
    ['learn', { learned: 0 }],
    ['remove', false],
    ['clear', 0]
  ] as const)('refuses stale %s after decrypt pauses and owner switches A→B', async (operation, expected) => {
    const ctx = directFixture()
    const id = await seedBoth(ctx.dictionary, ctx.partition)
    const beforeA = await readFile(ctx.file(PARTITION_A))
    const beforeB = await readFile(ctx.file(PARTITION_B))
    const gate = ctx.holdOpen()
    const pending = mutate(ctx.dictionary, operation, id)
    await expect(
      releaseAfterBarrier(gate.started, pending, gate.release, () => {
        ctx.partition.value = PARTITION_B
        ctx.epoch.value += 1
      })
    ).resolves.toEqual(expected)
    expect(await readFile(ctx.file(PARTITION_A))).toEqual(beforeA)
    expect(await readFile(ctx.file(PARTITION_B))).toEqual(beforeB)
    expect(terms((await ctx.dictionary.list()).entries)).toEqual([['mantis', 'Métis']])
  })

  it('refuses clear when the partition becomes unavailable during decrypt', async () => {
    const ctx = directFixture()
    await seedBoth(ctx.dictionary, ctx.partition)
    const beforeA = await readFile(ctx.file(PARTITION_A))
    const gate = ctx.holdOpen()
    const pending = ctx.dictionary.clear()
    await expect(
      releaseAfterBarrier(gate.started, pending, gate.release, () => {
        ctx.partition.value = null
        ctx.epoch.value += 1
      })
    ).resolves.toBe(0)
    expect(await readFile(ctx.file(PARTITION_A))).toEqual(beforeA)
  })

  it('rejects ABA learn after A→B→A because the owner epoch changed', async () => {
    const ctx = directFixture()
    await seedBoth(ctx.dictionary, ctx.partition)
    const beforeA = await readFile(ctx.file(PARTITION_A))
    const beforeB = await readFile(ctx.file(PARTITION_B))
    const gate = ctx.holdOpen()
    const pending = ctx.dictionary.learnFromCorrection(
      mintOwnedSpan('ask tota in the morning', 'dictation-turn'),
      'ask Toto in the morning'
    )
    await expect(
      releaseAfterBarrier(gate.started, pending, gate.release, () => {
        ctx.partition.value = PARTITION_B
        ctx.epoch.value += 1
        ctx.partition.value = PARTITION_A
      })
    ).resolves.toEqual({ learned: 0 })
    expect(await readFile(ctx.file(PARTITION_A))).toEqual(beforeA)
    expect(await readFile(ctx.file(PARTITION_B))).toEqual(beforeB)
  })

  it('refuses a queued mutation after its owner changes before the serial lane starts it', async () => {
    const ctx = directFixture()
    const id = await seedBoth(ctx.dictionary, ctx.partition)
    const beforeA = await readFile(ctx.file(PARTITION_A))
    const beforeB = await readFile(ctx.file(PARTITION_B))
    const callsBefore = ctx.openCalls()
    const gate = ctx.holdOpen()
    const inFlight = ctx.dictionary.list()
    let queued: Promise<{ learned: number }> | undefined
    await expect(
      releaseAfterBarrier(gate.started, inFlight, gate.release, () => {
        queued = ctx.dictionary.learnFromCorrection(
          mintOwnedSpan('ask tota tomorrow', 'dictation-turn'),
          'ask Toto tomorrow'
        )
        ctx.partition.value = PARTITION_B
        ctx.epoch.value += 1
      })
    ).resolves.toEqual({ status: 'unavailable', entries: [] })
    expect(queued).toBeDefined()
    await expect(queued!).resolves.toEqual({ learned: 0 })
    expect(ctx.openCalls()).toBe(callsBefore + 1)
    expect(await readFile(ctx.file(PARTITION_A))).toEqual(beforeA)
    expect(await readFile(ctx.file(PARTITION_B))).toEqual(beforeB)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('rechecks the owner after a prepared write waits for the target path lane', async () => {
    const ctx = directFixture()
    await seedBoth(ctx.dictionary, ctx.partition)
    const beforeA = await readFile(ctx.file(PARTITION_A))
    const beforeB = await readFile(ctx.file(PARTITION_B))
    const laneEntered = deferred()
    const laneReleased = deferred()
    const lane = withPathLane(ctx.file(PARTITION_A), async () => {
      laneEntered.resolve()
      await laneReleased.promise
    })
    let pending: Promise<{ learned: number }> | undefined
    let waitFailure: unknown

    try {
      await waitForBarrier(laneEntered.promise, lane)
      pending = ctx.dictionary.learnFromCorrection(
        mintOwnedSpan('ask tota after the meeting', 'dictation-turn'),
        'ask Toto after the meeting'
      )
      await expect
        .poll(async () =>
          (await readdir(join(ctx.root.path, 'dictionary'))).some(
            (name) => name.startsWith(`${PARTITION_A}.dd1.`) && name.endsWith('.tmp')
          )
        )
        .toBe(true)
      ctx.partition.value = PARTITION_B
      ctx.epoch.value += 1
    } catch (error) {
      waitFailure = error
    } finally {
      laneReleased.resolve()
    }

    await lane
    if (pending) {
      if (waitFailure) await pending.catch(() => {})
      else expect(await pending).toEqual({ learned: 0 })
    }
    if (waitFailure) throw waitFailure
    expect(await readFile(ctx.file(PARTITION_A))).toEqual(beforeA)
    expect(await readFile(ctx.file(PARTITION_B))).toEqual(beforeB)
    expect(
      (await readdir(join(ctx.root.path, 'dictionary'))).filter(
        (name) => name.startsWith(`${PARTITION_A}.dd1.`) && name.endsWith('.tmp')
      )
    ).toEqual([])
  })

  it('refuses a stale learn when the owner changes while encryption is paused before replacement', async () => {
    const ctx = directFixture()
    await seedBoth(ctx.dictionary, ctx.partition)
    const beforeA = await readFile(ctx.file(PARTITION_A))
    const gate = ctx.holdSeal()
    const pending = ctx.dictionary.learnFromCorrection(
      mintOwnedSpan('ask tota on Friday', 'dictation-turn'),
      'ask Toto on Friday'
    )
    await expect(
      releaseAfterBarrier(gate.started, pending, gate.release, () => {
        ctx.partition.value = PARTITION_B
        ctx.epoch.value += 1
      })
    ).resolves.toEqual({ learned: 0 })
    expect(await readFile(ctx.file(PARTITION_A))).toEqual(beforeA)
  })
})

describe('dictation memory mutation responses remain owner-bound (G26/G19)', () => {
  it('refuses a stale correction after decrypt and does not emit a learned audit', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const seeded = await seedMemoryDictionary(root)
    const partition = { value: PARTITION_A as string | null }
    const ctx = memoryFixture(root, partition, { holdKeyRead: true })
    ctx.memory.sink.inserted('turn-1', A_TEXT)
    const span = ctx.memory.spansRecent().spans[0]!
    const pending = ctx.memory.spansCorrect({ id: span.id, correctedText: 'please ask Toto about the plan' })
    await expect(
      releaseAfterBarrier(ctx.started, pending, ctx.release, () => {
        partition.value = PARTITION_B
        ctx.memory.onOwnerRevoked()
      })
    ).resolves.toEqual(REFUSED)
    expect(ctx.audits.some((record) => record.phase === 'dictionary_learned')).toBe(false)
    expect(await readFile(seeded.path)).toEqual(seeded.bytes)
    expect(await readMaybe(join(root.path, 'dictionary', `${PARTITION_B}.dd1`))).toBeNull()
  })

  it.each(['remove', 'clear'] as const)('refuses stale dictionary %s and does not audit success', async (operation) => {
    const root = makeTempRoot()
    roots.push(root)
    const seeded = await seedMemoryDictionary(root)
    const partition = { value: PARTITION_A as string | null }
    const ctx = memoryFixture(root, partition, { holdKeyRead: true })
    const pending =
      operation === 'remove' ? ctx.memory.dictionaryRemove({ id: seeded.id }) : ctx.memory.dictionaryClear()
    await expect(
      releaseAfterBarrier(ctx.started, pending, ctx.release, () => {
        partition.value = PARTITION_B
        ctx.memory.onOwnerRevoked()
      })
    ).resolves.toEqual(REFUSED)
    expect(
      ctx.audits.some((record) => record.phase === `dictionary_${operation === 'remove' ? 'removed' : 'cleared'}`)
    ).toBe(false)
    expect(await readFile(seeded.path)).toEqual(seeded.bytes)
    expect(await readMaybe(join(root.path, 'dictionary', `${PARTITION_B}.dd1`))).toBeNull()
  })

  it('refuses a pending clear after disposal and leaves the encrypted file unchanged', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const seeded = await seedMemoryDictionary(root)
    const partition = { value: PARTITION_A as string | null }
    const ctx = memoryFixture(root, partition, { holdKeyRead: true })
    const pending = ctx.memory.dictionaryClear()
    let disposing: Promise<void> | undefined
    await expect(
      releaseAfterBarrier(ctx.started, pending, ctx.release, () => {
        disposing = ctx.memory.dispose()
      })
    ).resolves.toEqual(REFUSED)
    await disposing
    expect(ctx.audits.some((record) => record.phase === 'dictionary_cleared')).toBe(false)
    expect(await readFile(seeded.path)).toEqual(seeded.bytes)
  })

  it('refuses a new clear after disposal without deleting or acknowledging the dictionary', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const seeded = await seedMemoryDictionary(root)
    const partition = { value: PARTITION_A as string | null }
    const ctx = memoryFixture(root, partition)
    await ctx.memory.dispose()

    expect(await ctx.memory.dictionaryClear()).toEqual(REFUSED)
    expect(ctx.audits.some((record) => record.phase === 'dictionary_cleared')).toBe(false)
    expect(await readFile(seeded.path)).toEqual(seeded.bytes)
  })

  it('rechecks ownership after enabled() reenters and revokes before a correction is queued', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const partition = { value: PARTITION_A as string | null }
    let revokeWhenEnabled = false
    let memory!: DictationMemory
    const ctx = memoryFixture(root, partition, {
      enabled: () => {
        if (revokeWhenEnabled) {
          revokeWhenEnabled = false
          partition.value = PARTITION_B
          memory.onOwnerRevoked()
        }
        return true
      }
    })
    memory = ctx.memory
    memory.sink.inserted('turn-1', A_TEXT)
    const span = memory.spansRecent().spans[0]!
    revokeWhenEnabled = true

    expect(await memory.spansCorrect({ id: span.id, correctedText: A_CORRECTED })).toEqual(REFUSED)
    expect(await readMaybe(join(root.path, 'dictionary', `${PARTITION_B}.dd1`))).toBeNull()
    expect(ctx.audits.some((record) => record.phase === 'dictionary_learned')).toBe(false)
  })

  it('refuses an acknowledgement if its audit callback revokes the owner after a completed removal', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const seeded = await seedMemoryDictionary(root)
    const partition = { value: PARTITION_A as string | null }
    let memory!: DictationMemory
    const ctx = memoryFixture(root, partition, {
      audit: (record) => {
        if (record.phase === 'dictionary_removed') {
          partition.value = PARTITION_B
          memory.onOwnerRevoked()
        }
      }
    })
    memory = ctx.memory

    expect(await memory.dictionaryRemove({ id: seeded.id })).toEqual(REFUSED)
    // The callback ran after deletion was already committed; stale acknowledgement is refused, but no undo is claimed.
    expect(await readFile(seeded.path)).not.toEqual(seeded.bytes)
    expect(ctx.audits.some((record) => record.phase === 'dictionary_removed')).toBe(true)
  })

  it('refuses stale learned acknowledgement after the audit callback revokes the owner; completed write remains', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const partition = { value: PARTITION_A as string | null }
    let memory!: DictationMemory
    const ctx = memoryFixture(root, partition, {
      audit: (record) => {
        if (record.phase === 'dictionary_learned') {
          partition.value = PARTITION_B
          memory.onOwnerRevoked()
        }
      }
    })
    memory = ctx.memory
    memory.sink.inserted('turn-1', A_TEXT)
    const span = memory.spansRecent().spans[0]!

    expect(await memory.spansCorrect({ id: span.id, correctedText: A_CORRECTED })).toEqual(REFUSED)
    const current = await readMaybe(join(root.path, 'dictionary', `${PARTITION_A}.dd1`))
    expect(current).not.toBeNull()
    expect(await readMaybe(join(root.path, 'dictionary', `${PARTITION_B}.dd1`))).toBeNull()
  })

  it('keeps disabled learning at zero while still permitting stable dictionary deletion', async () => {
    const root = makeTempRoot()
    roots.push(root)
    const seeded = await seedMemoryDictionary(root)
    let enabled = true
    const partition = { value: PARTITION_A as string | null }
    const ctx = memoryFixture(root, partition, { enabled: () => enabled })
    ctx.memory.sink.inserted('turn-1', A_TEXT)
    const span = ctx.memory.spansRecent().spans[0]!
    enabled = false

    expect(await ctx.memory.spansCorrect({ id: span.id, correctedText: A_CORRECTED })).toEqual({ ok: true, count: 0 })
    expect(await ctx.memory.dictionaryRemove({ id: seeded.id })).toEqual({ ok: true, count: 1 })
    expect(ctx.audits.some((record) => record.phase === 'dictionary_removed')).toBe(true)
    expect(await readMaybe(seeded.path)).not.toBeNull()
  })
})
