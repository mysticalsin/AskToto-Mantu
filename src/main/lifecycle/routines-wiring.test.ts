import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTINE_IPC } from '@shared/routines'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { bootstrapRoutines, routineNotification, type RoutinesWiringDeps } from './routines-wiring'

const KEY = 'a'.repeat(64)
const TENANT = '1'.repeat(64)
const PARTITION = 'ab12'.repeat(6)
const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a))
const open = (sealed: Buffer): string => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString('utf8')
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(options: { partition?: string | null; archived?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'routines-wiring-'))
  dirs.push(dir)
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  let revoked: () => void = () => {}
  const state = {
    archived: options.archived ?? false,
    partition: options.partition === undefined ? PARTITION : options.partition
  }
  const notify = vi.fn(() => 'allow' as const)
  const deps: RoutinesWiringDeps = {
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender: (() => null) as unknown as AuthorizeSender,
    requireAuth: () => true,
    ownerSession: {
      currentOwnerKey: () => KEY,
      currentTenantKey: () => TENANT,
      onRevoked: (cb) => {
        revoked = cb
        return () => {}
      }
    },
    userDataPath: () => dir,
    seal,
    open,
    assistants: {
      list: async () => ({
        ok: true as const,
        assistants: [{ assistantId: 'sys-sales', archived: state.archived }] as never
      })
    },
    powerMonitor: { on: () => undefined, removeListener: () => undefined },
    isOnline: () => true,
    quietAction: () => 'allow',
    notify,
    audit: vi.fn(),
    partition: () => state.partition,
    onPartitionChange: () => () => {},
    defaultTimeZone: () => 'UTC',
    tickMs: 3_600_000
  }
  const wired = bootstrapRoutines(deps)
  const call = (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw)
  const create = async () => {
    const compiled = (await call(ROUTINE_IPC.compile, {
      assistantId: 'sys-sales',
      purpose: 'reminder',
      title: 'Stand up',
      consentKind: 'recurring',
      phrase: 'every day at 9am'
    })) as { ok: boolean; proposalId: string; previewHash: string }
    expect(compiled.ok).toBe(true)
    return call(ROUTINE_IPC.consent, { proposalId: compiled.proposalId, previewHash: compiled.previewHash })
  }
  return { dir, wired, call, create, state, revoke: () => revoked(), notify }
}

describe('routines wiring (G66)', () => {
  it('registers the request channels and writes one sealed file per partition', async () => {
    const t = await setup()
    const consent = (await t.create()) as { ok: boolean }
    expect(consent.ok).toBe(true)
    expect(await readdir(join(t.dir, 'routines'))).toEqual([`${PARTITION}.bin`])
    t.wired.dispose()
  })

  it('partition file path validated', async () => {
    const t = await setup({ partition: '../../escape' })
    expect(await t.call(ROUTINE_IPC.list)).toEqual({ ok: false, reason: 'unavailable' })
    await expect(readdir(join(t.dir, 'routines'))).rejects.toBeTruthy()
    t.wired.dispose()
  })

  it('is signed out without a partition', async () => {
    const t = await setup({ partition: null })
    expect(await t.call(ROUTINE_IPC.list)).toEqual({ ok: false, reason: 'signed-out' })
    t.wired.dispose()
  })

  it('revocation stops runner', async () => {
    const t = await setup()
    await t.create()
    const before = (await t.call(ROUTINE_IPC.list)) as { routines: Array<{ availability: { runner: string } }> }
    expect(before.routines[0]!.availability.runner).toBe('running')
    t.revoke()
    const after = (await t.call(ROUTINE_IPC.list)) as { routines: Array<{ availability: { runner: string } }> }
    expect(after.routines[0]!.availability.runner).toBe('not_running')
    t.wired.dispose()
  })

  it('archived assistant pauses with archive', async () => {
    const t = await setup()
    await t.create()
    t.state.archived = true
    await t.wired.engine.tick()
    const out = (await t.call(ROUTINE_IPC.list)) as { routines: Array<{ pauseReasons: string[] }> }
    expect(out.routines[0]!.pauseReasons).toEqual(['archive'])
    t.wired.dispose()
  })

  it('notification copy is local and short', () => {
    expect(routineNotification({ kind: 'routine', purpose: 'reminder', title: 'Stand up' })).toEqual({
      title: 'Routine',
      body: 'Stand up'
    })
    expect(routineNotification({ kind: 'allowance', resetAt: null }).title).toBe('Routines paused')
  })
})
