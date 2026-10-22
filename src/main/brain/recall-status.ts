import type { RecallStatus } from '@shared/contracts/memory-partition'
import type { Settings } from '@shared/ipc'
import { resolveMemoryAccess } from '../memory-partition/memory-access'
import { indexUnavailable, readIndex } from './store'

/**
 * What a read of the verified owner's knowledge store found (Métis 2.12 G19), as one typed answer.
 *
 * The order matters: nobody verified or a partition that is not active yet is decided before any file is looked at,
 * so a refused read never touches (let alone reports on) another owner's store. A store that exists but cannot be
 * read here is `locked` (the key that decrypts it is not usable) or `unavailable`; only a store that was read and
 * holds no ingested meeting is `partition-empty`.
 */
export async function brainRecallStatus(s: Settings): Promise<RecallStatus> {
  const access = await resolveMemoryAccess()
  if (access.status !== 'ok') return access.status
  const cause = indexUnavailable(s)
  if (cause) return cause === 'undecryptable' ? 'locked' : 'unavailable'
  return Object.keys(readIndex(s).ingested).length === 0 ? 'partition-empty' : 'ok'
}
