import { createAssistantService } from '../assistant-service'
import { createAssistantStore, type AssistantFileIo, type AssistantScope } from '../assistant-store'

export const KEY_A = 'a'.repeat(64)
export const KEY_B = 'b'.repeat(64)
export const TENANT_1 = '1'.repeat(64)
export const TENANT_2 = '2'.repeat(64)

export const scopeOf = (ownerKey: string, tenantKey: string): AssistantScope => ({
  partitionId: `p${ownerKey.slice(0, 4)}${tenantKey.slice(0, 4)}`,
  ownerKey,
  tenantKey
})

/** A reversible, non-plaintext seal: enough to prove nothing readable reaches the io. */
export const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a))
export const open = (sealed: Buffer): string => {
  if (sealed.length === 0) throw new Error('empty')
  return Buffer.from(sealed.map((byte) => byte ^ 0x5a)).toString('utf8')
}

export function memoryIo(): AssistantFileIo & { files: Map<string, Buffer>; writes: number } {
  const files = new Map<string, Buffer>()
  const io = {
    files,
    writes: 0,
    async read(partitionId: string) {
      return files.get(partitionId) ?? null
    },
    async write(partitionId: string, data: Buffer) {
      io.writes += 1
      files.set(partitionId, data)
    }
  }
  return io
}

export interface Harness {
  io: ReturnType<typeof memoryIo>
  current: { scope: AssistantScope | null }
  clock: { now: number }
  meetings: Array<{ file: string; mode: string }>
  custom: Array<{ id: string; label: string }>
  newService(): ReturnType<typeof createAssistantService>
  store: ReturnType<typeof createAssistantStore>
}

export function harness(scope: AssistantScope | null = scopeOf(KEY_A, TENANT_1)): Harness {
  const io = memoryIo()
  const current = { scope }
  const clock = { now: 1_000_000 }
  const meetings: Array<{ file: string; mode: string }> = []
  const custom: Array<{ id: string; label: string }> = []
  const store = createAssistantStore({ io, seal, open, scope: () => current.scope })
  return {
    io,
    current,
    clock,
    meetings,
    custom,
    store,
    newService: () =>
      createAssistantService({
        store: createAssistantStore({ io, seal, open, scope: () => current.scope }),
        scope: () => current.scope,
        now: () => clock.now,
        customModes: () => custom,
        meetings: async () => meetings
      })
  }
}
