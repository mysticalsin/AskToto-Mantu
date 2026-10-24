import type { SealedScope, SealedScopedIo } from '../../../infra/storage/sealed-scoped-store'
import { createConversationService, type ConversationAuditPhase } from '../conversation-service'
import { createConversationStore } from '../conversation-store'
import { createWorkspaceService, type WorkspaceAuditPhase } from '../workspace-service'
import { createWorkspaceStore } from '../workspace-store'

export const KEY_A = 'a'.repeat(64)
export const KEY_B = 'b'.repeat(64)
export const TENANT_1 = '1'.repeat(64)
export const TENANT_2 = '2'.repeat(64)

export const scopeOf = (ownerKey: string, tenantKey: string): SealedScope => ({
  // The real G19 partition id shape: 24 lowercase hex characters.
  partitionId: `${ownerKey.slice(0, 2)}${tenantKey.slice(0, 2)}`.repeat(6),
  ownerKey,
  tenantKey
})

/** A reversible, non-plaintext seal: enough to prove nothing readable reaches the io. */
export const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a))
export const open = (sealed: Buffer): string => {
  if (sealed.length === 0) throw new Error('empty')
  return Buffer.from(sealed.map((byte) => byte ^ 0x5a)).toString('utf8')
}

export function memoryIo(): SealedScopedIo & { files: Map<string, Buffer>; writes: number } {
  const files = new Map<string, Buffer>()
  const io = {
    files,
    writes: 0,
    async read(partitionId: string, name?: string) {
      return files.get(`${partitionId}/${name ?? 'index'}`) ?? null
    },
    async write(partitionId: string, data: Buffer, name?: string) {
      io.writes += 1
      files.set(`${partitionId}/${name ?? 'index'}`, data)
    }
  }
  return io
}

export function harness(scope: SealedScope | null = scopeOf(KEY_A, TENANT_1)) {
  const indexIo = memoryIo()
  const turnIo = memoryIo()
  const current = { scope }
  const clock = { now: 1_000_000 }
  const wsIo = memoryIo()
  const wsAudits: Array<{ phase: WorkspaceAuditPhase; detail: object }> = []
  const assistants: Array<{ id: string; archived: boolean; name?: string }> = [
    { id: 'sys-general', archived: false, name: 'General' }
  ]
  const meetings: string[] = ['m1.md']
  const remote = { epoch: 1, active: false, ttlMs: 7_200_000 }
  const audits: Array<{ phase: ConversationAuditPhase; detail: object }> = []
  const store = () => createConversationStore({ indexIo, turnIo, seal, open, scope: () => current.scope })
  const newService = () =>
    createConversationService({
      store: store(),
      scope: () => current.scope,
      now: () => clock.now,
      assistants: async () => assistants,
      meetings: async () => meetings,
      remote: () => remote,
      audit: (phase, detail) => audits.push({ phase, detail })
    })
  const newWorkspace = () =>
    createWorkspaceService({
      conversations: store(),
      workspace: createWorkspaceStore({ io: wsIo, seal, open, scope: () => current.scope }),
      scope: () => current.scope,
      now: () => clock.now,
      assistants: async () => assistants,
      meetings: async () => meetings,
      remote: () => remote,
      audit: (phase, detail) => wsAudits.push({ phase, detail })
    })
  return {
    indexIo,
    turnIo,
    wsIo,
    wsAudits,
    current,
    clock,
    assistants,
    meetings,
    remote,
    audits,
    store,
    newService,
    newWorkspace
  }
}

export const turn = (role: 'user' | 'assistant', text: string) => ({ role, text })
