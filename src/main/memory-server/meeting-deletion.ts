import { createHash } from 'node:crypto'
import type { MemoryScope } from '@shared/contracts/memory-partition'
import type { MemoryServerAdapter, MemoryServerResult, MemoryServerTombstone } from './contract'
import { configuredMemoryServerAdapter, deleteMemoryForCurrentOwner } from './client'

/** Stable, path-free reference shared by local deletion and any future owner-configured retain integration. */
export function memorySourceIdForMeeting(file: string): string {
  const basename = file.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return createHash('sha256').update('metis.memory-source.v1\0').update(basename).digest('hex')
}

export async function deleteMemoryForLocalMeeting(
  file: string,
  testSeam?: { adapter: MemoryServerAdapter; scope: MemoryScope }
): Promise<MemoryServerResult<MemoryServerTombstone[]>> {
  const sourceId = memorySourceIdForMeeting(file)
  try {
    if (testSeam) return await testSeam.adapter.delete(testSeam.scope, { sourceId })
    if (!configuredMemoryServerAdapter()) return { status: 'unavailable' }
    return await deleteMemoryForCurrentOwner({ sourceId })
  } catch {
    return { status: 'unavailable' }
  }
}
