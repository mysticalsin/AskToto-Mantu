import type { JournalState, ManifestCore } from './incremental-meeting-journal-format'
import { MAX_MANIFEST_BYTES, setManifestStoredBytes } from './incremental-meeting-journal-format'

type BoundedManifestRead = { status: 'ok'; core: ManifestCore; bytes: Buffer } | { status: 'missing' | 'unavailable' }

export interface IncrementalJournalStateOperationsOptions {
  baseCurrent: () => boolean
  activeCheck: (base: () => boolean, request: () => boolean) => () => boolean
  readManifest(requestCurrent: () => boolean): Promise<BoundedManifestRead>
  writeAtomic(name: string, bytes: Buffer, requestCurrent: () => boolean, maxBytes: number): Promise<boolean>
  readonly manifestName: string
  readonly maxJournalBytes: number
  readonly key: Buffer
}

export function createIncrementalJournalStateOperations(options: IncrementalJournalStateOperationsOptions) {
  return {
    async readPendingAppend(isCurrent: () => boolean): Promise<'pending' | 'clear' | 'unavailable'> {
      const requestCurrent = options.activeCheck(options.baseCurrent, isCurrent)
      const loaded = await options.readManifest(requestCurrent)
      if (loaded.status !== 'ok' || !requestCurrent()) return 'unavailable'
      const pending = loaded.core.pending !== null
      loaded.bytes.fill(0)
      return requestCurrent() ? (pending ? 'pending' : 'clear') : 'unavailable'
    },

    async transitionState(
      state: Exclude<JournalState, 'active'>,
      isCurrent: () => boolean
    ): Promise<'committed' | 'stale-owner' | 'unavailable'> {
      const requestCurrent = options.activeCheck(options.baseCurrent, isCurrent)
      if (!requestCurrent()) return 'stale-owner'
      const loaded = await options.readManifest(requestCurrent)
      if (loaded.status !== 'ok' || !requestCurrent()) return 'unavailable'
      if (loaded.core.state !== 'active' || loaded.core.pending) {
        loaded.bytes.fill(0)
        return 'unavailable'
      }
      const core: ManifestCore = { ...loaded.core, state, manifestBytes: 0 }
      const recordBytes = core.storedBytes - loaded.core.manifestBytes
      const bytes = setManifestStoredBytes(core, recordBytes, options.key)
      loaded.bytes.fill(0)
      if (!requestCurrent()) {
        bytes.fill(0)
        return 'stale-owner'
      }
      if (bytes.byteLength > MAX_MANIFEST_BYTES || core.storedBytes > options.maxJournalBytes) {
        bytes.fill(0)
        return 'unavailable'
      }
      const wrote = await options.writeAtomic(options.manifestName, bytes, requestCurrent, options.maxJournalBytes)
      return wrote ? 'committed' : requestCurrent() ? 'unavailable' : 'stale-owner'
    }
  }
}
