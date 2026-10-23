/**
 * export-service.ts — the one place a Métis export is written.
 *
 * Every user-initiated export (meeting markdown copy, recap PDF, diagnostics bundle) goes through here:
 * save dialog -> destination preview (resolved path, name, size, whether it exists) -> conflict policy
 * (keep both, replace, cancel; never silent) -> re-check at write time -> atomic write -> SHA-256 of exactly
 * the bytes written -> receipt appended to a local log. A failure says so and leaves no half file.
 *
 * Residual window: the final conflict check runs synchronously immediately before the rename, but a rename
 * is not an exclusive create, so another process can still win a race measured in microseconds.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MessageBoxOptions, SaveDialogOptions } from 'electron'
import type { ExportConflictResolution, ExportKind, ExportReceipt } from '@shared/ipc'
import { atomicSavedWrite } from '../../infra/storage/atomic-saved-write'
import {
  ExportRefusal,
  keepBothName,
  planDestination,
  validateExportName,
  writeTimeCheck,
  type ConflictPolicy,
  type DestinationPlan
} from './export-destination'
import { appendReceipt } from './export-receipts'

export interface ExportServiceDeps {
  showSaveDialog: (options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  receiptLogPath: () => string
  platform?: NodeJS.Platform
  now?: () => Date
  newId?: () => string
}

export interface ExportFileRequest {
  kind: ExportKind
  bytes: Buffer
  /** Human label for the preview, e.g. "meeting copy". */
  label: string
  dialog: SaveDialogOptions
}
export interface ExportDirectoryRequest {
  kind: ExportKind
  entries: { name: string; bytes: Buffer }[]
  label: string
  dialog: SaveDialogOptions
}

export type ExportOutcome =
  | { ok: true; receipt: ExportReceipt; receiptLogged: boolean }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }

export interface ExportService {
  exportFile: (request: ExportFileRequest) => Promise<ExportOutcome>
  exportDirectory: (request: ExportDirectoryRequest) => Promise<ExportOutcome>
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const NOTHING_WRITTEN = 'Export failed; no file was written at the chosen location.'

export function createExportService(deps: ExportServiceDeps): ExportService {
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? ((): Date => new Date())
  const newId = deps.newId ?? ((): string => randomUUID())

  /** Dialog + preview + policy. Returns the decision, a cancel, or a refusal. */
  async function decide(
    request: { dialog: SaveDialogOptions; label: string },
    totalBytes: number,
    isDirectory: boolean
  ): Promise<
    | { plan: DestinationPlan; finalName: string; policy: ConflictPolicy }
    | { cancelled: true }
    | { error: string }
  > {
    const chosen = await deps.showSaveDialog(request.dialog)
    if (chosen.canceled || !chosen.filePath) return { cancelled: true }
    const plan = await planDestination(chosen.filePath, { platform, isDirectory })
    if ('refused' in plan) return { error: `Export refused: ${plan.refused} Nothing was written.` }
    const size = formatSize(totalBytes)
    const lines = [`Destination: ${plan.destination}`, `Name: ${plan.name}`, `Size: about ${size}`]
    if (!plan.existing) {
      const r = await deps.showMessageBox({
        type: 'question',
        message: `Export ${request.label}?`,
        detail: lines.join('\n'),
        buttons: ['Export', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      return r.response === 0 ? { plan, finalName: plan.name, policy: 'none' } : { cancelled: true }
    }
    let siblings: string[]
    try {
      siblings = [plan.existing.name, plan.name, ...(await readdir(plan.directory))]
    } catch {
      return { error: 'Export refused: the destination folder could not be read. Nothing was written.' }
    }
    const copyName = keepBothName(plan.name, siblings, platform, isDirectory)
    const existingNote = `Already exists: ${plan.existing.name} (${formatSize(plan.existing.size)})`
    const detail = [...lines, existingNote, `Keep both saves this one as: ${copyName}`]
    if (isDirectory) {
      const r = await deps.showMessageBox({
        type: 'warning',
        message: `A folder named "${plan.existing.name}" already exists.`,
        detail: detail.join('\n'),
        buttons: ['Keep both', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      return r.response === 0 ? { plan, finalName: copyName, policy: 'keep-both' } : { cancelled: true }
    }
    const r = await deps.showMessageBox({
      type: 'warning',
      message: `A file named "${plan.existing.name}" already exists.`,
      detail: detail.join('\n'),
      buttons: ['Keep both', 'Replace', 'Cancel'],
      defaultId: 0,
      cancelId: 2
    })
    if (r.response === 0) return { plan, finalName: copyName, policy: 'keep-both' }
    if (r.response === 1) return { plan, finalName: plan.name, policy: 'replace' }
    return { cancelled: true }
  }

  async function finish(
    kind: ExportKind,
    destination: string,
    bytes: number,
    digest: string,
    policy: ConflictPolicy
  ): Promise<ExportOutcome> {
    const receipt: ExportReceipt = {
      exportId: newId(),
      kind,
      destination,
      bytes,
      sha256: digest,
      writtenAt: now().toISOString(),
      conflictResolution: policy as ExportConflictResolution
    }
    let receiptLogged = true
    try {
      await appendReceipt(deps.receiptLogPath(), receipt)
    } catch {
      receiptLogged = false
    }
    return { ok: true, receipt, receiptLogged }
  }

  function failure(error: unknown): ExportOutcome {
    if (error instanceof ExportRefusal) return { ok: false, error: `Export refused: ${error.message} Nothing was written.` }
    return { ok: false, error: NOTHING_WRITTEN }
  }

  return {
    async exportFile(request) {
      const decision = await decide(request, request.bytes.byteLength, false)
      if ('cancelled' in decision) return { ok: false, cancelled: true }
      if ('error' in decision) return { ok: false, error: decision.error }
      const { plan, finalName, policy } = decision
      const destination = join(plan.directory, finalName)
      const digest = sha256(request.bytes)
      try {
        await atomicSavedWrite(destination, request.bytes, () => writeTimeCheck(plan, finalName, policy, platform))
      } catch (error) {
        return failure(error)
      }
      // The write succeeded; prove the file on disk is exactly what was digested.
      try {
        const info = await stat(destination)
        const onDisk = info.size === request.bytes.byteLength ? sha256(await readFile(destination)) : ''
        if (onDisk !== digest) {
          return { ok: false, error: 'Export finished but the saved file did not verify against its digest; please export again.' }
        }
      } catch {
        return { ok: false, error: 'Export finished but the saved file could not be verified; please export again.' }
      }
      return finish(request.kind, destination, request.bytes.byteLength, digest, policy)
    },

    async exportDirectory(request) {
      for (const entry of request.entries) {
        const invalid = validateExportName(entry.name, platform)
        if (invalid) return { ok: false, error: `Export refused: ${invalid} Nothing was written.` }
      }
      const total = request.entries.reduce((n, e) => n + e.bytes.byteLength, 0)
      const decision = await decide(request, total, true)
      if ('cancelled' in decision) return { ok: false, cancelled: true }
      if ('error' in decision) return { ok: false, error: decision.error }
      const { plan, finalName, policy } = decision
      const destination = join(plan.directory, finalName)
      let created = false
      try {
        writeTimeCheck(plan, finalName, policy, platform)
        // Non-recursive: EEXIST means something appeared since the check, and we refuse instead of merging.
        await mkdir(destination)
        created = true
        for (const entry of request.entries) {
          await atomicSavedWrite(join(destination, entry.name), entry.bytes)
        }
      } catch (error) {
        if (created) await rm(destination, { recursive: true, force: true }).catch(() => {})
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          return { ok: false, error: 'Export refused: that folder appeared since the preview. Nothing was written.' }
        }
        return failure(error)
      }
      const lines = [...request.entries]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((e) => `${e.name}\t${sha256(e.bytes)}\n`)
        .join('')
      return finish(request.kind, destination, total, sha256(lines), policy)
    }
  }
}
