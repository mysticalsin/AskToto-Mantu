import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PriorDraft } from '../desktop-contract'
import { PARTITION_A, PARTITION_B, makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createDictationMemory, type DictationMemory, type DictationMemoryDeps } from './dictation-memory'
import { createDictationJournal } from './dictation-journal'
import { createMemoryKeyring, type MemoryKeyring } from './dictation-memory-crypto'

const roots: Array<{ path: string; remove(): void }> = []
const memories: DictationMemory[] = []
const keyrings: MemoryKeyring[] = []

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

const draft = (text: string): PriorDraft => ({
  operationId: 'dictation:owner-race',
  text,
  textHash: 'synthetic-hash',
  transcriptRevision: 1,
  targetFingerprint: 'synthetic-target',
  state: 'draft',
  reason: 'superseded',
  preservedAtMs: 5_000
})

const originalText = 'please ask tota about the plan'
const correctedText = 'please ask Toto about the plan'
const correction = (id: string) => ({ id, correctedText })

async function seedOfferedDraft() {
  const root = makeTempRoot()
  roots.push(root)
  const memoryRoot = join(root.path, 'dictation-memory')
  const seed = createDictationMemory({
    rootDir: () => memoryRoot,
    keys: syntheticKeys(),
    partition: () => PARTITION_A,
    enabled: () => true,
    now: () => 5_000
  })
  seed.sink.draftPreserved('turn-1', draft(originalText))
  seed.sink.turnEnded('turn-1')
  await seed.flush()
  const notice = await seed.recoveryTake()
  const item = notice?.items[0]
  if (!item) throw new Error('expected the seeded recovery draft to be offered')
  await seed.dispose()

  const file = join(memoryRoot, 'journal', `${item.id}.dj1`)
  return { root, memoryRoot, id: item.id, file, originalBytes: await readFile(file) }
}

function reader(
  memoryRoot: string,
  partition: { value: string | null },
  options: {
    enabled?: DictationMemoryDeps['enabled']
    audit?: DictationMemoryDeps['audit']
    holdKeyRead?: boolean
  } = {}
) {
  const keys = syntheticKeys()
  const realReadFile = keys.readFile.bind(keys)
  const started = deferred()
  const released = deferred()
  let holdKeyRead = options.holdKeyRead ?? false
  let keyReads = 0
  const keyPath = join(memoryRoot, 'key.v1')
  keys.readFile = async (path) => {
    if (path === keyPath) {
      keyReads += 1
      if (holdKeyRead) {
        holdKeyRead = false
        started.resolve()
        await released.promise
      }
    }
    return realReadFile(path)
  }
  const memory = createDictationMemory({
    rootDir: () => memoryRoot,
    keys,
    partition: () => partition.value,
    enabled: options.enabled ?? (() => true),
    audit: options.audit,
    now: () => 5_000
  })
  memories.push(memory)
  return {
    memory,
    started: started.promise,
    release: () => released.resolve(),
    keyReads: () => keyReads
  }
}

describe('dictation recovery resolution remains bound to the owner generation (G26/G19)', () => {
  it('resolves a stable owner draft once and learns only from that owned recovery text', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    const { memory } = reader(seeded.memoryRoot, owner)

    expect(await memory.recoveryResolve(correction(seeded.id))).toEqual({ ok: true, count: 1 })
    expect(await memory.recoveryResolve(correction(seeded.id))).toEqual({ ok: false, count: 0 })
    const dictionary = await memory.dictionaryList()
    expect(dictionary.status).toBe('ok')
    expect(dictionary.entries.map(({ heard, preferred }) => [heard, preferred])).toEqual([['tota', 'Toto']])
  })

  it('still allows dismissing an offered draft while dictation is disabled', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    const { memory } = reader(seeded.memoryRoot, owner, { enabled: () => false })

    expect(await memory.recoveryResolve({ id: seeded.id })).toEqual({ ok: true, count: 0 })
    await expect(readFile(seeded.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not learn into B if the resolved audit callback revokes A before learning starts', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    let memory!: DictationMemory
    let revoked = false
    const reading = reader(seeded.memoryRoot, owner, {
      audit: (record) => {
        if (record.phase !== 'recovery_resolved' || revoked) return
        revoked = true
        owner.value = PARTITION_B
        memory.onOwnerRevoked()
      }
    })
    memory = reading.memory

    const result = await memory.recoveryResolve(correction(seeded.id))
    const b = await memory.dictionaryList()
    expect.soft(result).toEqual({ ok: false, count: 0 })
    expect.soft(b.status).toBe('ok')
    expect.soft(b.entries).toEqual([])
  })

  it('does not decrypt a queued stale resolve after the first resolve observes revocation', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    const epoch = { value: 0 }
    // This fresh journal instance only resolves the seeded offer; it does not run launch/sweep housekeeping.
    const realKeyring = createMemoryKeyring({
      keyPath: join(seeded.memoryRoot, 'key.v1'),
      keys: syntheticKeys()
    })
    const gated = withOpenBarrier(realKeyring)
    keyrings.push(gated.keyring)
    const journal = createDictationJournal({
      rootDir: () => join(seeded.memoryRoot, 'journal'),
      keyring: gated.keyring,
      partition: () => owner.value,
      ownerEpoch: () => epoch.value,
      enabled: () => true,
      now: () => 5_000
    })
    const gate = gated.holdNextOpen()
    const first = journal.resolve(seeded.id)
    await gate.started
    const queued = journal.resolve(seeded.id)
    owner.value = PARTITION_B
    epoch.value += 1
    gate.release()

    expect(await first).toEqual({ status: 'unknown' })
    expect(await queued).toEqual({ status: 'unknown' })
    expect(gated.openCalls()).toBe(1)
    expect(await readFile(seeded.file)).toEqual(seeded.originalBytes)
  })

  it('refuses an A resolution after switching to B before deleting A and lets A resolve later', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    const { memory, started, release } = reader(seeded.memoryRoot, owner, { holdKeyRead: true })
    const pending = memory.recoveryResolve(correction(seeded.id))
    await started
    owner.value = PARTITION_B
    memory.onOwnerRevoked()
    release()

    const result = await pending
    const bytesAfter = await readFile(seeded.file).catch(() => null)
    const b = await memory.dictionaryList()
    expect.soft(result).toEqual({ ok: false, count: 0 })
    expect.soft(bytesAfter).toEqual(seeded.originalBytes)
    expect.soft(b.status).toBe('ok')
    expect.soft(b.entries).toEqual([])

    owner.value = PARTITION_A
    memory.onOwnerRevoked()
    expect(await memory.recoveryResolve(correction(seeded.id))).toEqual({ ok: true, count: 1 })
    expect(await memory.recoveryResolve(correction(seeded.id))).toEqual({ ok: false, count: 0 })
  })

  it('refuses an A resolution after sign-out before deleting A and preserves the offered draft', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    const { memory, started, release } = reader(seeded.memoryRoot, owner, { holdKeyRead: true })
    const pending = memory.recoveryResolve(correction(seeded.id))
    await started
    owner.value = null
    memory.onOwnerRevoked()
    release()

    expect(await pending).toEqual({ ok: false, count: 0 })
    expect(await readFile(seeded.file)).toEqual(seeded.originalBytes)
    owner.value = PARTITION_A
    memory.onOwnerRevoked()
    expect(await memory.recoveryResolve(correction(seeded.id))).toEqual({ ok: true, count: 1 })
  })

  it('invalidates a pending A resolution across revoke and same-partition return (ABA)', async () => {
    const seeded = await seedOfferedDraft()
    const owner = { value: PARTITION_A as string | null }
    const { memory, started, release, keyReads } = reader(seeded.memoryRoot, owner, { holdKeyRead: true })
    const pending = memory.recoveryResolve(correction(seeded.id))
    await started
    owner.value = null
    memory.onOwnerRevoked()
    owner.value = PARTITION_A
    memory.onOwnerRevoked()
    release()

    expect(await pending).toEqual({ ok: false, count: 0 })
    expect(await readFile(seeded.file)).toEqual(seeded.originalBytes)
    expect(keyReads()).toBe(1)
    expect(await memory.recoveryResolve(correction(seeded.id))).toEqual({ ok: true, count: 1 })
  })
})
