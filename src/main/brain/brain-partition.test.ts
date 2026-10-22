import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { AccountEntitySchema, PersonEntitySchema } from '@shared/brain'
import { configureMemoryPartitions, resetMemoryAccessForTests } from '../memory-partition/memory-access'
import { createMemoryPartitions, type MemoryIdentity } from '../memory-partition/memory-partitions'
import type { LedgerIo } from '../memory-partition/partition-ledger'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { buildBrainContextWithSources, resetMatchKeyCacheForTests } from './context'
import { createBrainContextOwner } from './context-owner'
import {
  brainContextForProvider,
  createBrainContextEnvelope,
  isBrainContextEnvelopeCurrent
} from './context-envelope'
import { brainRecallStatus } from './recall-status'
import {
  brainDir,
  listPreservedBrainIndexes,
  purgeBrain,
  readAccount,
  readIndex,
  readPerson,
  writeAccount,
  writeIndex,
  writePerson
} from './store'

vi.mock('electron')

const key = (c: string): string => c.repeat(64)
const TENANT = key('1')
const OTHER_TENANT = key('2')
const ALICE = key('a')
const BOB = key('b')
const ROOT = 'c'.repeat(64)
const MEETING = { file: 'm1.md', date: '2026-06-01', title: 'Renewal call', sourceRootId: ROOT }
const digestOf = (file: string): string => createHash('sha256').update(file).digest('hex')
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

const verified = (tenantKey: string, ownerKey: string): MemoryIdentity => ({
  kind: 'verified',
  scope: { tenantKey, ownerKey }
})

describe('G19: the knowledge store is partitioned by verified tenant and user', () => {
  let folder: string
  let s: Settings
  let identity: MemoryIdentity
  let ledgerText: string | null
  let partitions: ReturnType<typeof createMemoryPartitions>

  const ledger: LedgerIo = {
    read: async () => ledgerText,
    write: async (text) => {
      ledgerText = text
    }
  }
  const signIn = async (next: MemoryIdentity): Promise<void> => {
    identity = next
    await partitions.activate()
  }
  const seed = async (slug: string, name: string): Promise<void> => {
    await writePerson(s, slug, PersonEntitySchema.parse({ id: slug, name, meetings: [MEETING] }))
    await settleBrainWritesForTests()
    const index = readIndex(s)
    await writeIndex(s, {
      ...index,
      ingested: { ...index.ingested, [MEETING.file]: { at: 1, ok: true, sourceRootId: ROOT, sourceDigest: digestOf(MEETING.file) } }
    })
  }

  beforeEach(() => {
    resetMatchKeyCacheForTests()
    folder = mkdtempSync(join(tmpdir(), 'asktoto-g19-'))
    s = { meetingsFolder: folder } as Settings
    identity = { kind: 'signed-out' }
    ledgerText = null
    partitions = createMemoryPartitions({
      source: { identity: () => identity },
      ledger,
      legacyOwnerHint: async () => null
    })
    configureMemoryPartitions(partitions)
  })

  afterEach(async () => {
    resetMemoryAccessForTests()
    await settleBrainWritesForTests()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('a read under one owner never returns another owner’s records', async () => {
    await signIn(verified(TENANT, ALICE))
    await seed('maria-silva', 'Maria Silva')
    expect(readPerson(s, 'maria-silva')?.name).toBe('Maria Silva')
    const alicePath = join(brainDir(s), 'entities', 'person', 'maria-silva.json')
    const aliceBytes = sha(alicePath)

    await signIn(verified(TENANT, BOB))
    expect(readPerson(s, 'maria-silva')).toBeNull()
    expect(readIndex(s).ingested).toEqual({})
    const asked = await buildBrainContextWithSources(s, 'what did Maria Silva say')
    expect(asked.matched).toBe(false)
    expect(asked.block).toBe('')
    expect(asked.recallStatus).toBe('partition-empty')

    await writeAccount(s, 'initech', AccountEntitySchema.parse({ id: 'initech', name: 'Initech', meetings: [MEETING] }))
    await settleBrainWritesForTests()
    expect(readAccount(s, 'initech')?.name).toBe('Initech')

    await signIn(verified(TENANT, ALICE))
    expect(readPerson(s, 'maria-silva')?.name).toBe('Maria Silva')
    expect(readAccount(s, 'initech')).toBeNull()
    // The other partition stayed where it was, byte for byte.
    expect(sha(alicePath)).toBe(aliceBytes)
  })

  it('an account switch to another tenant or user sees an empty partition and leaves the first one on disk', async () => {
    await signIn(verified(TENANT, ALICE))
    await seed('maria-silva', 'Maria Silva')
    expect(await brainRecallStatus(s)).toBe('ok')

    await signIn(verified(OTHER_TENANT, ALICE))
    expect(await brainRecallStatus(s)).toBe('partition-empty')
    await signIn(verified(TENANT, BOB))
    expect(await brainRecallStatus(s)).toBe('partition-empty')

    const roots = readdirSync(folder).filter((name) => name.startsWith('.brain'))
    expect(roots).toContain('.brain')
    expect(existsSync(join(folder, '.brain', 'entities', 'person', 'maria-silva.json'))).toBe(true)
    await signIn(verified(TENANT, ALICE))
    expect(await brainRecallStatus(s)).toBe('ok')
  })

  it('an owner switch is refused as stale until the new partition is active, then resolved by the async read', async () => {
    await signIn(verified(TENANT, ALICE))
    await seed('maria-silva', 'Maria Silva')
    identity = verified(TENANT, BOB)
    expect(partitions.access()).toEqual({ status: 'stale' })
    expect(readPerson(s, 'maria-silva')).toBeNull() // never the previous owner's file while the switch is pending
    expect(await brainRecallStatus(s)).toBe('partition-empty')
  })

  it('signed out reads return a typed status and nothing from the last owner', async () => {
    await signIn(verified(TENANT, ALICE))
    await seed('maria-silva', 'Maria Silva')
    identity = { kind: 'signed-out' }
    expect(await brainRecallStatus(s)).toBe('signed-out')
    const asked = await buildBrainContextWithSources(s, 'what did Maria Silva say')
    expect(asked).toMatchObject({ matched: false, block: '', recallStatus: 'signed-out' })
    expect(readPerson(s, 'maria-silva')).toBeNull()
    expect(readIndex(s).ingested).toEqual({})
  })

  it('a write while nobody is verified is refused and creates no store', async () => {
    await expect(writePerson(s, 'maria-silva', PersonEntitySchema.parse({ id: 'maria-silva', name: 'Maria Silva' }))).rejects.toMatchObject({
      name: 'MemoryClosedError',
      status: 'signed-out'
    })
    expect(readdirSync(folder).filter((name) => name.startsWith('.brain'))).toEqual([])
  })

  it('data that predates the partitions belongs to the first verified owner, once', async () => {
    resetMemoryAccessForTests() // written by an earlier build: no partitions configured
    await seed('maria-silva', 'Maria Silva')
    configureMemoryPartitions(partitions)

    await signIn(verified(TENANT, BOB)) // the first verified owner adopts it
    expect(readPerson(s, 'maria-silva')?.name).toBe('Maria Silva')
    await signIn(verified(TENANT, ALICE)) // a later owner does not
    expect(readPerson(s, 'maria-silva')).toBeNull()
    expect(await brainRecallStatus(s)).toBe('partition-empty')
    await signIn(verified(TENANT, BOB))
    expect(readPerson(s, 'maria-silva')?.name).toBe('Maria Silva')
    expect(JSON.parse(ledgerText ?? '{}').legacy.ownerKey).toBe(BOB)
  })

  it('an index this device cannot decrypt reads as locked, and one it cannot use as unavailable', async () => {
    await signIn(verified(TENANT, ALICE))
    const root = brainDir(s)
    mkdirSync(root, { recursive: true })
    const envelope = {
      v: 2,
      iv: randomBytes(12).toString('base64'),
      tag: randomBytes(16).toString('base64'),
      ct: randomBytes(64).toString('base64'),
      kLocal: 'F:' + randomBytes(72).toString('base64')
    }
    writeFileSync(join(root, 'index.json'), Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from(JSON.stringify(envelope))]))
    expect(await brainRecallStatus(s)).toBe('locked')
    const asked = await buildBrainContextWithSources(s, 'what did Maria Silva say')
    expect(asked).toMatchObject({ matched: false, recallStatus: 'locked' })

    writeFileSync(join(root, 'index.json'), JSON.stringify({ schema_version: 999 }))
    expect(await brainRecallStatus(s)).toBe('unavailable')
  })

  it('preserved index copies and an erase are scoped to the partition in force', async () => {
    await signIn(verified(TENANT, ALICE))
    await seed('maria-silva', 'Maria Silva')
    const aliceIndex = readFileSync(join(brainDir(s), 'index.json'))
    mkdirSync(join(folder, '.brain-preserved'), { recursive: true })
    writeFileSync(join(folder, '.brain-preserved', 'index.before-restore-1.json'), aliceIndex)
    expect(listPreservedBrainIndexes(s)).toHaveLength(1)

    await signIn(verified(TENANT, BOB))
    expect(listPreservedBrainIndexes(s)).toEqual([])
    await seed('tom-becker', 'Tom Becker')
    expect(purgeBrain(s, { mode: 'erase' }).ok).toBe(true)
    expect(existsSync(brainDir(s))).toBe(false)

    expect(existsSync(join(folder, '.brain', 'entities', 'person', 'maria-silva.json'))).toBe(true)
    expect(existsSync(join(folder, '.brain-preserved', 'index.before-restore-1.json'))).toBe(true)
  })

  it('an answer context built under one owner is dropped once another owner’s partition is in force', async () => {
    const owner = createBrainContextOwner({ inputContext: () => ({ authSessionGeneration: 1, contextRevision: 1 }) })
    await signIn(verified(TENANT, ALICE))
    await seed('maria-silva', 'Maria Silva')
    const aliceOwner = owner(s)
    const built = await buildBrainContextWithSources(s, 'what did Maria Silva say')
    expect(built.matched).toBe(true)
    expect(built.recallStatus).toBe('ok')
    const envelope = createBrainContextEnvelope(aliceOwner, built)
    expect(brainContextForProvider(envelope, owner(s))).toContain('Maria Silva')

    await signIn(verified(TENANT, BOB))
    const bobOwner = owner(s)
    expect(bobOwner.profileKey).not.toBe(aliceOwner.profileKey)
    expect(isBrainContextEnvelopeCurrent(envelope, bobOwner)).toBe(false)
    expect(brainContextForProvider(envelope, bobOwner)).toBeUndefined()

    await signIn(verified(TENANT, ALICE))
    expect(owner(s).profileKey).toBe(aliceOwner.profileKey)
  })
})
