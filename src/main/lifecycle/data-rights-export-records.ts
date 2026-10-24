import type { DictionaryList } from '@shared/dictation-memory'
import type { UserMemoryList } from '@shared/user-memory'
import { sourceIdOf, type ExtraRecord } from '../features/data-rights/data-export'

export interface ExportedEntity {
  kind: 'person' | 'account' | 'deal'
  slug: string
  record: unknown
  /** The meeting files this derived record came from; they become `derivedFrom` source ids. */
  meetingFiles: readonly string[]
  modifiedAt: number
}

/** What the export needs from each exportable store besides meetings; main binds these to the owning modules. */
export interface ExportRecordSources {
  assistants(): Promise<
    Array<{ assistantId: string; name: string; base: string; instructions: string; updatedAt: number }>
  >
  userMemory(): Promise<UserMemoryList>
  dictionary(): Promise<DictionaryList>
  brainEntities(): Promise<ExportedEntity[]>
}

async function settled<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null // one store failing to read never stops the export of the others; the error text is never kept
  }
}

/** The owner's records from the exportable stores other than meetings, with origin and what each was derived from. */
export async function collectExtraRecords(sources: ExportRecordSources): Promise<ExtraRecord[]> {
  const out: ExtraRecord[] = []

  for (const assistant of (await settled(sources.assistants)) ?? [])
    out.push({
      store: 'assistants',
      name: assistant.assistantId,
      sourceId: sourceIdOf(assistant.assistantId),
      origin: 'user-typed',
      modifiedAt: assistant.updatedAt,
      text: JSON.stringify({ name: assistant.name, base: assistant.base, instructions: assistant.instructions })
    })

  const memory = await settled(sources.userMemory)
  if (memory?.status === 'ok')
    for (const item of memory.items) {
      const derived = item.source === 'derived'
      out.push({
        store: 'user-memory',
        name: item.id,
        sourceId: sourceIdOf(item.id),
        origin: derived ? 'derived' : 'user-typed',
        ...(derived && item.conversation ? { derivedFrom: [sourceIdOf(item.conversation)] } : {}),
        modifiedAt: item.at,
        text: JSON.stringify({ kind: item.kind, text: item.text, source: item.source, expiresAt: item.expiresAt })
      })
    }

  const dictionary = await settled(sources.dictionary)
  if (dictionary?.status === 'ok')
    for (const entry of dictionary.entries)
      out.push({
        store: 'dictation-memory',
        name: entry.id,
        sourceId: sourceIdOf(entry.id),
        origin: 'user-typed',
        modifiedAt: entry.updatedAtMs,
        text: JSON.stringify({ heard: entry.heard, preferred: entry.preferred, count: entry.count })
      })

  for (const entity of (await settled(sources.brainEntities)) ?? [])
    out.push({
      store: 'brain',
      name: `${entity.kind}/${entity.slug}`,
      sourceId: sourceIdOf(`${entity.kind}/${entity.slug}`),
      origin: 'derived',
      derivedFrom: entity.meetingFiles.map(sourceIdOf),
      modifiedAt: entity.modifiedAt,
      text: JSON.stringify({ kind: entity.kind, slug: entity.slug, record: entity.record })
    })

  return out
}
