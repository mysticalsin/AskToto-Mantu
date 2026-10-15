import type { IncrementalJournalApplicationMetadataResult } from './incremental-meeting-journal'
import { MAX_MANIFEST_BYTES, setManifestStoredBytes, validCounter } from './incremental-meeting-journal-format'
import type { ManifestCore } from './incremental-meeting-journal-format'

type ManifestRead = { status: 'ok'; core: ManifestCore; bytes: Buffer } | { status: 'missing' | 'unavailable' }

export interface ApplicationMetadataStore {
  readApplicationMetadata(isCurrent: () => boolean): Promise<IncrementalJournalApplicationMetadataResult>
  commitApplicationMetadata(
    expectedRevision: number,
    bytes: Uint8Array | null,
    maxBytes: number,
    isCurrent: () => boolean
  ): Promise<IncrementalJournalApplicationMetadataResult>
}

export function createApplicationMetadataStore(options: {
  baseCurrent: () => boolean
  maxJournalBytes: number
  key: Buffer
  readManifest: (isCurrent: () => boolean) => Promise<ManifestRead>
  writeManifest: (core: ManifestCore, recordBytes: number, isCurrent: () => boolean) => Promise<boolean>
}): ApplicationMetadataStore {
  const current = (request: () => boolean) => () => options.baseCurrent() && safeCurrent(request)
  return {
    async readApplicationMetadata(isCurrent) {
      const requestCurrent = current(isCurrent)
      if (!requestCurrent()) return { status: 'stale-owner' }
      const loaded = await options.readManifest(requestCurrent)
      if (loaded.status !== 'ok' || !requestCurrent())
        return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
      try {
        const encoded = loaded.core.applicationMetadata
        if (encoded === null) return { status: 'ok', revision: loaded.core.applicationRevision, bytes: null }
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.toString('base64') !== encoded || !requestCurrent()) {
          bytes.fill(0)
          return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
        }
        const output = Uint8Array.from(bytes)
        bytes.fill(0)
        return { status: 'ok', revision: loaded.core.applicationRevision, bytes: output }
      } catch {
        return { status: 'unavailable' }
      } finally {
        loaded.bytes.fill(0)
      }
    },

    async commitApplicationMetadata(expectedRevision, suppliedBytes, maxBytes, isCurrent) {
      const requestCurrent = current(isCurrent)
      const loaded = await options.readManifest(requestCurrent)
      if (loaded.status !== 'ok' || !requestCurrent())
        return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
      const old = loaded.core
      if (old.pending || old.state !== 'active') {
        loaded.bytes.fill(0)
        return { status: 'unavailable' }
      }
      if (!validCounter(expectedRevision) || expectedRevision !== old.applicationRevision) {
        loaded.bytes.fill(0)
        return { status: 'stale-revision' }
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        loaded.bytes.fill(0)
        return { status: 'limit' }
      }
      if (!validCounter(old.applicationRevision + 1)) {
        loaded.bytes.fill(0)
        return { status: 'limit' }
      }
      const recordBytes = old.storedBytes - old.manifestBytes
      const core: ManifestCore = {
        ...old,
        applicationRevision: old.applicationRevision + 1,
        applicationMetadata: suppliedBytes === null ? null : '',
        manifestBytes: 0
      }
      let emptyManifest: Buffer
      try {
        emptyManifest = setManifestStoredBytes(core, recordBytes, options.key)
      } catch {
        loaded.bytes.fill(0)
        return { status: 'limit' }
      }
      // Leave room for numeric fields to cross a decimal boundary as base64 grows. This rejects
      // impossible requests before copying or encoding the caller's data.
      const encodedCapacity = Math.max(0, MAX_MANIFEST_BYTES - emptyManifest.byteLength - 64 + 2)
      emptyManifest.fill(0)
      let encodedMetadata: string | null = null
      let ownedMetadata: Uint8Array | null = null
      if (suppliedBytes !== null) {
        const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object
        const lengthGetter = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get
        const offsetGetter = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get
        const bufferGetter = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get
        const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
        const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
        let byteLength = -1
        try {
          if (!(suppliedBytes instanceof Uint8Array) || Object.getPrototypeOf(suppliedBytes) !== Uint8Array.prototype)
            throw new Error()
          byteLength = lengthGetter?.call(suppliedBytes) as number
          const byteOffset = offsetGetter?.call(suppliedBytes) as number
          const buffer = bufferGetter?.call(suppliedBytes) as unknown
          if (
            !lengthGetter ||
            !offsetGetter ||
            !bufferGetter ||
            !arrayBufferLengthGetter ||
            !resizableGetter ||
            !(buffer instanceof ArrayBuffer) ||
            byteOffset !== 0 ||
            arrayBufferLengthGetter.call(buffer) !== byteLength ||
            resizableGetter.call(buffer) === true
          )
            throw new Error()
        } catch {
          loaded.bytes.fill(0)
          return { status: 'limit' }
        }
        const base64Length = 4 * Math.ceil(byteLength / 3)
        if (byteLength <= 0 || byteLength > maxBytes || base64Length > encodedCapacity) {
          loaded.bytes.fill(0)
          return { status: 'limit' }
        }
        ownedMetadata = new Uint8Array(new ArrayBuffer(byteLength))
        ownedMetadata.set(suppliedBytes)
        encodedMetadata = Buffer.from(ownedMetadata).toString('base64')
      }
      core.applicationMetadata = encodedMetadata
      loaded.bytes.fill(0)
      if (!requestCurrent()) {
        ownedMetadata?.fill(0)
        return { status: 'stale-owner' }
      }
      const manifest = setManifestStoredBytes(core, recordBytes, options.key)
      const withinLimits = manifest.byteLength <= 16_384 && core.storedBytes <= options.maxJournalBytes
      manifest.fill(0)
      if (!withinLimits) {
        ownedMetadata?.fill(0)
        return { status: 'limit' }
      }
      const wrote = await options.writeManifest(core, recordBytes, requestCurrent)
      if (!wrote || !requestCurrent()) {
        ownedMetadata?.fill(0)
        return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
      }
      const output = ownedMetadata === null ? null : Uint8Array.from(ownedMetadata)
      ownedMetadata?.fill(0)
      return { status: 'ok', revision: core.applicationRevision, bytes: output }
    }
  }
}

function safeCurrent(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}
