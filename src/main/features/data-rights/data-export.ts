/**
 * The data export (Métis 2.12 G82, CAP-35 / R095): the owner's records as plain files plus `manifest.json`, written
 * through the G58 conflict-safe `exportDirectory` (save dialog, destination preview, keep-both, atomic write, receipt).
 *
 * The manifest gives every record its store, an opaque source id (a hash of the file name: the name itself can carry a
 * title), its origin, what it was derived from, its modification time, its byte count and the SHA-256 of exactly the
 * bytes written. A meeting that is only in the cloud is skipped, never downloaded; a file that is not Métis's own
 * content, or cannot be read, is skipped with a closed reason. Nothing is written to a log, and the receipt G58 keeps
 * carries the destination and a digest, never content.
 */
import { createHash } from 'node:crypto'
import type { DataExportResult } from '@shared/data-rights'
import type { DataStoreId } from '@shared/data-store-inventory'
import type { ExportKind } from '@shared/ipc'

/** The slice of the G58 export service this feature uses, declared here so the feature does not import another feature. */
export interface ExportDirectoryRequest {
  kind: ExportKind
  entries: { name: string; bytes: Buffer }[]
  label: string
  dialog: { title?: string; buttonLabel?: string; defaultPath?: string }
}
export type ExportOutcome = { ok: true } | { ok: false; cancelled: true } | { ok: false; error: string }

export type RecordOrigin = 'meeting-capture' | 'import' | 'user-typed' | 'derived'
export type SkipReason = 'not-downloaded' | 'not-owner-content' | 'unreadable'

export type MeetingRead =
  | { status: 'ok'; markdown: string; modifiedAt: number; origin: RecordOrigin }
  | { status: SkipReason }

export interface ExtraRecord {
  store: DataStoreId
  name: string
  sourceId: string
  origin: RecordOrigin
  derivedFrom?: readonly string[]
  modifiedAt: number
  text: string
}

export interface DataExportDeps {
  listMeetingFiles(): Promise<readonly string[]>
  /** Reads one saved meeting without hydrating a cloud-only placeholder. */
  readMeeting(file: string): Promise<MeetingRead>
  /** Records from the other exportable stores (assistants, user memory, derived knowledge), already decrypted by main. */
  extraRecords(): Promise<readonly ExtraRecord[]>
  exportDirectory(request: ExportDirectoryRequest): Promise<ExportOutcome>
  now(): Date
  appVersion(): string
}

export const DATA_EXPORT_KIND: ExportKind = 'data-rights-bundle'

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
export const sourceIdOf = (name: string): string => sha256(name).slice(0, 32)

interface ManifestRecord {
  store: DataStoreId
  name: string
  sourceId: string
  origin: RecordOrigin
  derivedFrom?: readonly string[]
  modifiedAt: number
  sha256: string
  bytes: number
}
interface ManifestSkip {
  store: DataStoreId
  sourceId?: string
  reason: SkipReason
}

export function createDataExport(deps: DataExportDeps): () => Promise<DataExportResult> {
  return async () => {
    const entries: Array<{ name: string; bytes: Buffer }> = []
    const records: ManifestRecord[] = []
    const skipped: ManifestSkip[] = []
    const add = (
      store: DataStoreId,
      name: string,
      sourceId: string,
      text: string,
      meta: Pick<ManifestRecord, 'origin' | 'modifiedAt' | 'derivedFrom'>
    ): void => {
      const bytes = Buffer.from(text, 'utf8')
      entries.push({ name, bytes })
      records.push({
        store,
        name,
        sourceId,
        ...meta,
        ...(meta.derivedFrom ? { derivedFrom: meta.derivedFrom } : {}),
        sha256: sha256(bytes),
        bytes: bytes.byteLength
      })
    }

    let index = 0
    for (const file of await deps.listMeetingFiles()) {
      const sourceId = sourceIdOf(file)
      const read = await deps.readMeeting(file)
      if (read.status !== 'ok') {
        skipped.push({ store: 'meetings', sourceId, reason: read.status })
        continue
      }
      index += 1
      add('meetings', `meeting-${String(index).padStart(4, '0')}.md`, sourceId, read.markdown, {
        origin: read.origin,
        modifiedAt: read.modifiedAt
      })
    }
    const counters = new Map<string, number>()
    for (const extra of await deps.extraRecords()) {
      const n = (counters.get(extra.store) ?? 0) + 1
      counters.set(extra.store, n)
      add(extra.store, `${extra.store}-${String(n).padStart(4, '0')}.json`, extra.sourceId, extra.text, {
        origin: extra.origin,
        modifiedAt: extra.modifiedAt,
        ...(extra.derivedFrom ? { derivedFrom: extra.derivedFrom } : {})
      })
    }

    const manifest = {
      v: 1,
      exportedAt: deps.now().toISOString(),
      appVersion: deps.appVersion(),
      records,
      skipped
    }
    entries.push({ name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') })
    const outcome = await deps.exportDirectory({
      kind: DATA_EXPORT_KIND,
      entries,
      label: 'your Métis data',
      dialog: { title: 'Export my Métis data', buttonLabel: 'Export', defaultPath: 'metis-data' }
    })
    if (outcome.ok) return { ok: true, records: records.length, skipped: skipped.length }
    if ('cancelled' in outcome) return { ok: true, cancelled: true, records: 0, skipped: 0 }
    return { ok: false, reason: 'unavailable' }
  }
}
