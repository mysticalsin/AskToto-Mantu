import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKSPACE_IPC } from '@shared/conversation-workspace'
import { CONVERSATION_IPC } from '@shared/conversations'
import { makeTempRoot } from '../features/dictation/__fixtures__/dictation-memory-fixtures'
import { open, seal } from '../features/conversations/__fixtures__/conversation-harness'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { readModuleSource } from '../../test-helpers/module-source'
import { bootstrapConversations } from './conversations-wiring'

const KEY_A = 'a'.repeat(64)
const TENANT = '1'.repeat(64)
const PARTITION = 'a1'.repeat(12)
const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})

function wiring(state: { owner: string | null; tenant: string | null; partition: string | null }) {
  const root = makeTempRoot('synthetic-conversations-')
  roots.push(root)
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const audits: object[] = []
  const { service, workspace } = bootstrapConversations({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender: (() => null) as unknown as AuthorizeSender,
    requireAuth: () => true,
    ownerSession: { currentOwnerKey: () => state.owner, currentTenantKey: () => state.tenant },
    userDataPath: () => root.path,
    partition: () => state.partition,
    seal,
    open,
    assistants: {
      list: async () => ({
        ok: true as const,
        assistants: [
          {
            assistantId: 'sys-general',
            name: 'General',
            base: 'general',
            instructions: '',
            createdAt: 0,
            updatedAt: 0,
            revision: 1,
            archived: false,
            system: true
          }
        ]
      })
    },
    meetings: async () => [{ file: 'm1.md' }],
    remote: () => ({ epoch: 1, active: false, ttlMs: 1000 }),
    audit: (record) => audits.push(record),
    workspaceAudit: (record) => audits.push(record)
  })
  return { root, handlers, service, workspace, audits, call: (c: string, raw?: unknown) => handlers.get(c)!({}, raw) }
}

describe('conversations wiring (G49)', () => {
  it('registers the channels and keeps sealed files under userData/conversations, named by partition and conversation', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: PARTITION })
    expect([...w.handlers.keys()].sort()).toEqual(
      [...Object.values(CONVERSATION_IPC), ...Object.values(WORKSPACE_IPC)].sort()
    )
    const opened = (await w.call(CONVERSATION_IPC.open, { assistantId: 'sys-general' })) as {
      conversation: { id: string }
    }
    const id = opened.conversation.id
    await w.call(CONVERSATION_IPC.append, {
      conversationId: id,
      assistantId: 'sys-general',
      runId: 'r1',
      turns: [{ role: 'user', text: 'synthetic-private-turn' }]
    })
    const dir = join(w.root.path, 'conversations')
    expect(readdirSync(dir).sort()).toEqual([PARTITION, `${PARTITION}.bin`].sort())
    expect(readdirSync(join(dir, PARTITION))).toEqual([`${id}.bin`])
    const turns = readFileSync(join(dir, PARTITION, `${id}.bin`))
    expect(turns.toString('utf8')).not.toContain('synthetic-private-turn')
    expect(open(turns)).toContain('synthetic-private-turn')
    expect(open(readFileSync(join(dir, `${PARTITION}.bin`)))).toContain(KEY_A)
    expect(JSON.stringify(w.audits)).not.toContain('synthetic')
  })

  it('has no scope without both keys and a partition in force, and answers signed-out', async () => {
    const state = {
      owner: KEY_A as string | null,
      tenant: TENANT as string | null,
      partition: PARTITION as string | null
    }
    const w = wiring(state)
    for (const mutate of [
      () => (state.owner = null),
      () => ((state.owner = KEY_A), (state.tenant = null)),
      () => ((state.tenant = TENANT), (state.partition = null))
    ]) {
      mutate()
      expect(await w.call(CONVERSATION_IPC.list)).toEqual({ ok: false, reason: 'signed-out' })
    }
    expect(readdirSync(w.root.path)).toEqual([])
  })

  it('follows a partition switch: each partition has its own files and sees only its own threads', async () => {
    const state = {
      owner: KEY_A as string | null,
      tenant: TENANT as string | null,
      partition: PARTITION as string | null
    }
    const w = wiring(state)
    await w.call(CONVERSATION_IPC.open, { assistantId: 'sys-general' })
    state.partition = 'b2'.repeat(12)
    expect(await w.call(CONVERSATION_IPC.list)).toEqual({ ok: true, conversations: [] })
    state.partition = PARTITION
    expect(((await w.call(CONVERSATION_IPC.list)) as { conversations: unknown[] }).conversations).toHaveLength(1)
  })

  it('refuses a partition or conversation segment that could leave the directory', async () => {
    const state = {
      owner: KEY_A as string | null,
      tenant: TENANT as string | null,
      partition: '../escape' as string | null
    }
    const w = wiring(state)
    expect(await w.call(CONVERSATION_IPC.open, { assistantId: 'sys-general' })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(readdirSync(w.root.path)).toEqual([])
    const source = readModuleSource(__dirname, './conversations-wiring').text
    expect(source).toContain('[0-9a-f]{24}')
    expect(source).toContain('c_[0-9a-f]{32}')
  })

  it('keeps the workspace state sealed in its own file per partition and refuses a bad partition or any name', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: PARTITION })
    const opened = (await w.call(CONVERSATION_IPC.open, { assistantId: 'sys-general' })) as {
      conversation: { id: string }
    }
    expect(await w.call(WORKSPACE_IPC.select, { conversationId: opened.conversation.id })).toMatchObject({ ok: true })
    const dir = join(w.root.path, 'conversation-workspace')
    expect(readdirSync(dir)).toEqual([`${PARTITION}.bin`])
    const sealed = readFileSync(join(dir, `${PARTITION}.bin`))
    expect(sealed.toString('utf8')).not.toContain('selected')
    expect(open(sealed)).toContain(opened.conversation.id)
    expect(JSON.stringify(w.audits)).not.toContain(opened.conversation.id)

    const bad = wiring({ owner: KEY_A, tenant: TENANT, partition: '../escape' })
    expect(await bad.call(WORKSPACE_IPC.get)).toEqual({ ok: false, reason: 'unavailable' })
    expect(readdirSync(bad.root.path)).toEqual([])
    const source = readModuleSource(__dirname, './conversations-wiring').text
    expect(source).toContain("throw new Error('invalid workspace document')")
  })
})
