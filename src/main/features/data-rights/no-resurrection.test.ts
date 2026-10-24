import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addPreEnrolItem,
  emptyQueueState,
  loadQueueState,
  purgeOperatorQueue,
  saveQueueState
} from '../../operator-queue'
import { enqueueJobs, isJobAdmissionOpen, type JobHooks } from '../../brain/ingest-job-hooks'
import {
  configureErasureFence,
  createErasureFence,
  erasureFenceFile,
  isErasureFenced,
  isErasureFencedName
} from '../../memory-partition/erasure-fence'
import { runErasure } from './erasure-orchestrator'
import { createProductionErasers, type ErasureHost } from './erasers'

const OWNER_PID = 'a1'.repeat(12)
const OTHER_PID = 'b2'.repeat(12)
const ERASED_AT = Date.UTC(2026, 9, 24, 12, 0, 0)
const BEFORE = ERASED_AT - 3_600_000
const AFTER = ERASED_AT + 3_600_000

const roots: string[] = []
afterEach(() => {
  configureErasureFence(null)
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-erasure-')))
  roots.push(path)
  return path
}

/** Installs a fence for the 'legacy' partition (what unconfigured memory access resolves to) or the given one. */
async function fenceAt(userData: string, erasedAt = ERASED_AT, partition = 'legacy') {
  const fence = createErasureFence(erasureFenceFile(userData))
  expect(await fence.record(partition, 'c'.repeat(32), erasedAt)).toBe(true)
  configureErasureFence(fence)
  return fence
}

describe('the erasure fence (G82)', () => {
  it('fences only items that started before the erasure, per partition, and survives a relaunch', async () => {
    const dir = root()
    await fenceAt(dir, ERASED_AT, OWNER_PID)
    expect(isErasureFenced(BEFORE, OWNER_PID)).toBe(true)
    expect(isErasureFenced(AFTER, OWNER_PID)).toBe(false)
    expect(isErasureFenced(BEFORE, OTHER_PID)).toBe(false)
    const relaunched = createErasureFence(erasureFenceFile(dir)) // a fresh process reads the file
    await relaunched.ready
    configureErasureFence(relaunched)
    expect(isErasureFenced(BEFORE, OWNER_PID)).toBe(true)
  })

  it('fences a file by its start stamp and never one with no stamp', async () => {
    await fenceAt(root())
    const stampOf = (ms: number): string => {
      const d = new Date(ms)
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }
    expect(isErasureFencedName(`${stampOf(BEFORE)}-planning.md`)).toBe(true)
    expect(isErasureFencedName(`.autosave-draft-${stampOf(BEFORE)}-123.md`)).toBe(true)
    expect(isErasureFencedName(`${stampOf(AFTER)}-planning.md`)).toBe(false)
    expect(isErasureFencedName('README.md')).toBe(false)
  })

  it('a fence only moves forward', async () => {
    const fence = await fenceAt(root(), ERASED_AT, OWNER_PID)
    await fence.record(OWNER_PID, 'd'.repeat(32), BEFORE)
    expect(fence.erasedAt(OWNER_PID)).toBe(ERASED_AT)
  })
})

describe('no resurrection (G82)', () => {
  it('ingest job enqueued before erasure writes no brain file; one enqueued after is admitted', async () => {
    await fenceAt(root())
    const old: JobHooks = {}
    const fresh: JobHooks = {}
    enqueueJobs([] as JobHooks[], [old], () => BEFORE)
    enqueueJobs([] as JobHooks[], [fresh], () => AFTER)
    expect(isJobAdmissionOpen(old)).toBe(false)
    expect(isJobAdmissionOpen(fresh)).toBe(true)
  })

  it('operator outbox empty', () => {
    const dir = root()
    saveQueueState(dir, addPreEnrolItem(emptyQueueState(), { id: 'i1', path: '/x', body: {}, enqueuedAt: 1 }, 1))
    purgeOperatorQueue(dir)
    expect(JSON.stringify(loadQueueState(dir))).not.toContain('i1')
  })

  it('same scope signs in again: assistants, user memory, dictation dictionary empty; brain partition and backup absent', async () => {
    const user = root()
    const meetings = root()
    const file = (...parts: string[]): string => join(user, ...parts)
    const put = (path: string): void => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'synthetic')
    }
    for (const pid of [OWNER_PID, OTHER_PID]) {
      put(file('assistants', `${pid}.bin`))
      put(file('user-memory', `${pid}.um1`))
      put(file('dictation-memory', 'dictionary', `${pid}.dd1`))
      put(join(meetings, `.brain-p-${pid}`, 'index.json'))
      put(join(meetings, `.brain-p-${pid}.backup-v1`, 'index.json'))
      put(join(meetings, `.brain-p-${pid}-preserved`, 'index.json'))
    }
    put(join(meetings, `.brain-p-${OWNER_PID}.corrections-preserve.json`))
    put(join(meetings, '.autosave-draft-2026-10-24_100000-123.md'))
    put(file('transcript-receipts', 'receipts.v1.json'))
    put(file('meeting-journal', 'abc', 'x'))
    put(file('crash-1-0.log'))
    put(file('identity', 'memory-partitions.v1.json'))
    put(file('logs', 'audit.log'))
    const fence = createErasureFence(erasureFenceFile(user))
    configureErasureFence(fence)
    const host: ErasureHost = {
      userData: () => user,
      partitionId: () => OWNER_PID,
      meetingsFolder: () => meetings,
      brainRoot: () => join(meetings, `.brain-p-${OWNER_PID}`),
      deleteMeetings: async () => ({ ok: true, deleted: 0, failed: 0 }),
      meetingCount: async () => 0,
      purgeBrain: () => ({ ok: true }),
      removeWiki: () => ({ ok: true }),
      purgeGraph: () => undefined,
      clearArtifacts: () => undefined,
      clearHistoryCache: () => undefined,
      clearTaskBrowserProfile: async () => true,
      purgeOperatorQueue: () => undefined,
      clearMainLog: async () => undefined,
      runCredentialCleanup: async () => ({ failed: 0 })
    }
    const receipt = await runErasure({
      erasers: createProductionErasers(host),
      writeFence: (id, at) => fence.record(OWNER_PID, id, at),
      quiesce: async () => undefined,
      now: Date.now,
      newId: () => 'e'.repeat(32),
      audit: () => undefined
    })
    expect(receipt.failed).toBe(0)
    // this owner's files are gone, so a second sign-in with the same account reads empty stores
    for (const path of [
      file('assistants', `${OWNER_PID}.bin`),
      file('user-memory', `${OWNER_PID}.um1`),
      file('dictation-memory', 'dictionary', `${OWNER_PID}.dd1`),
      join(meetings, `.brain-p-${OWNER_PID}`),
      join(meetings, `.brain-p-${OWNER_PID}.backup-v1`),
      join(meetings, `.brain-p-${OWNER_PID}-preserved`),
      join(meetings, `.brain-p-${OWNER_PID}.corrections-preserve.json`),
      join(meetings, '.autosave-draft-2026-10-24_100000-123.md'),
      file('transcript-receipts'),
      file('meeting-journal'),
      file('crash-1-0.log')
    ]) {
      expect(existsSync(path), path.replace(user, '<userData>').replace(meetings, '<meetings>')).toBe(false)
    }
    // another owner's partition files, the audit log and the identity records are untouched
    for (const path of [
      file('assistants', `${OTHER_PID}.bin`),
      file('user-memory', `${OTHER_PID}.um1`),
      file('dictation-memory', 'dictionary', `${OTHER_PID}.dd1`),
      join(meetings, `.brain-p-${OTHER_PID}`),
      join(meetings, `.brain-p-${OTHER_PID}.backup-v1`),
      file('logs', 'audit.log'),
      file('identity', 'memory-partitions.v1.json')
    ]) {
      expect(existsSync(path)).toBe(true)
    }
    expect(readdirSync(join(user, 'identity'))).toContain('erasures.v1.json')
  })
})
