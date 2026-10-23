import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSISTANT_IPC } from '@shared/assistants'
import { makeTempRoot } from '../features/dictation/__fixtures__/dictation-memory-fixtures'
import { open, seal } from '../features/assistants/__fixtures__/assistant-harness'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { readModuleSource } from '../../test-helpers/module-source'
import { bootstrapAssistants } from './assistants-wiring'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const TENANT = '1'.repeat(64)
const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})

function wiring(state: { owner: string | null; tenant: string | null; partition: string | null }) {
  const root = makeTempRoot('synthetic-assistants-')
  roots.push(root)
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  let partitionListener: (() => void) | null = null
  const service = bootstrapAssistants({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender: (() => null) as unknown as AuthorizeSender,
    requireAuth: () => true,
    ownerSession: {
      currentOwnerKey: () => state.owner,
      currentTenantKey: () => state.tenant,
      onRevoked: () => () => undefined
    },
    userDataPath: () => root.path,
    partition: () => state.partition,
    onPartitionChange: (cb) => {
      partitionListener = cb
      return () => undefined
    },
    customModes: () => [],
    meetings: async () => [{ file: 'm1.md', mode: 'meeting' }],
    seal,
    open,
    audit: () => undefined
  })
  return { root, handlers, service, switched: () => partitionListener?.(), call: (c: string, raw?: unknown) => handlers.get(c)!({}, raw) }
}

describe('assistants wiring (G48)', () => {
  it('registers the channels and keeps the sealed assistant file under userData/assistants, named by partition', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: 'a1'.repeat(12) })
    expect([...w.handlers.keys()].sort()).toEqual(Object.values(ASSISTANT_IPC).sort())
    const proposal = (await w.call(ASSISTANT_IPC.propose, {
      drafts: [{ name: 'Wiring Coach', base: 'support', instructions: 'synthetic-private-instruction' }]
    })) as { proposalId: string; previewHash: string }
    await w.call(ASSISTANT_IPC.confirm, { proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    const dir = join(w.root.path, 'assistants')
    expect(readdirSync(dir)).toEqual([`${'a1'.repeat(12)}.bin`])
    const raw = readFileSync(join(dir, `${'a1'.repeat(12)}.bin`))
    expect(raw.toString('utf8')).not.toContain('synthetic-private-instruction')
    expect(open(raw)).toContain('Wiring Coach')
  })

  it('has no scope without both keys and a partition in force, and a partition change drops pending proposals', async () => {
    const state = { owner: KEY_A as string | null, tenant: TENANT as string | null, partition: 'a1'.repeat(12) as string | null }
    const w = wiring(state)
    const proposal = (await w.call(ASSISTANT_IPC.propose, { drafts: [{ name: 'X', base: 'general', instructions: '' }] })) as {
      proposalId: string
      previewHash: string
    }
    state.owner = KEY_B
    state.partition = 'b2'.repeat(12)
    w.switched()
    state.owner = KEY_A
    state.partition = 'a1'.repeat(12)
    expect(
      await w.call(ASSISTANT_IPC.confirm, { proposalId: proposal.proposalId, previewHash: proposal.previewHash })
    ).toEqual({ ok: false, reason: 'unknown-proposal' })
    for (const missing of [{ owner: null }, { tenant: null }, { partition: null }]) {
      Object.assign(state, { owner: KEY_A, tenant: TENANT, partition: 'a1'.repeat(12) }, missing)
      expect(await w.call(ASSISTANT_IPC.list)).toEqual({ ok: false, reason: 'signed-out' })
    }
    expect(existsSync(join(w.root.path, 'assistants'))).toBe(false)
  })

  it('refuses a partition id that could escape the fixed assistant directory', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: '../other' })
    expect(await w.call(ASSISTANT_IPC.list)).toEqual({ ok: false, reason: 'unavailable' })
    expect(existsSync(join(w.root.path, 'other.bin'))).toBe(false)
    expect(existsSync(join(w.root.path, 'assistants'))).toBe(false)
  })

  it('is composed from the owner-session wiring, so index.ts gains no lines', () => {
    const source = readModuleSource(__dirname, './owner-session-wiring').text
    expect(source).toMatch(/bootstrapAssistants\(\{/)
  })
})
