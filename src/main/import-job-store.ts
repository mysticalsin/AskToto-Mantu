import { app } from 'electron'
import { constants as fsConstants, lstatSync } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import {
  canRetainImportedTranscript,
  ImportRetentionAuthorityUnavailableError,
  ImportRetentionBlockedError,
  type ImportRetentionState
} from './import-retention-policy'
import { decodeSaved, writeSaved } from './transcripts'
import type { ImportHoldInventory, ImportJob, ImportJobStore } from './import-job-types'

const MAX_HELD_JOB_IDS = 1_024
const MAX_HOLD_SCAN_ENTRIES = 4_096
const MAX_MARKER_BYTES = 256
const UUID_JOB_ID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
const LEGACY_JOB_ID_PATTERN = '[0-9a-f]{32}'
const JOB_ID_PATTERN = `(?:${UUID_JOB_ID_PATTERN}|${LEGACY_JOB_ID_PATTERN})`
const JOB_NAME = new RegExp(`^job-(${JOB_ID_PATTERN})\\.json$`)
const HOLD_NAME = new RegExp(`^job-(${JOB_ID_PATTERN})\\.hold\\.json$`)
const GLOBAL_HOLD_NAME = 'summary-only-hold-all.json'

interface RootIdentity {
  dev: number
  ino: number
}

interface HoldMarker {
  version: 1
  jobId: string
  reason: 'policy' | 'restart'
}

interface GlobalHoldMarker {
  version: 1
  state: 'overflow'
  reason: 'policy' | 'restart'
}

/**
 * Encrypted-at-rest persistence for resumable imports. The app writes transcript text and the source
 * fingerprint, never decoded audio. Policy holds are fixed-size sidecars; checkpoint payloads remain
 * untouched and are never deserialized while transcript retention is forbidden.
 */
export class EncryptedImportJobStore implements ImportJobStore {
  constructor(
    private readonly getSettings: () => Settings,
    private readonly root = join(app.getPath('userData'), 'import-jobs'),
    private readonly retentionStatus?: () => ImportRetentionState,
    private readonly refreshRetentionStatus?: () => Promise<ImportRetentionState>
  ) {}

  async save(job: ImportJob, beforeReplace?: () => void): Promise<void> {
    await this.refreshAndAssertRetentionAllowed()
    this.assertRetentionAllowed()
    const rootIdentity = await this.ensureRoot()
    await this.refreshAndAssertRetentionAllowed()
    await writeSaved(this.path(job.jobId), JSON.stringify(job), this.getSettings().encryptTranscripts, () => {
      this.assertRootIdentityBeforeReplace(rootIdentity)
      this.assertRetentionAllowed()
      beforeReplace?.()
    })
  }

  async list(): Promise<ImportJob[]> {
    await this.refreshAndAssertRetentionAllowed()
    if (!this.retentionAllowed()) return []
    const rootIdentity = await this.existingRoot()
    if (!rootIdentity) return []
    const names = await readdir(this.root)
    await this.assertRootIdentity(rootIdentity)
    await this.refreshAndAssertRetentionAllowed()
    const jobs: ImportJob[] = []
    const globalFence = await this.globalHoldPresent(rootIdentity)
    for (const name of names) {
      const match = JOB_NAME.exec(name)
      if (!match) continue
      const jobId = match[1]
      if (await this.markerPresent(this.holdPath(jobId), rootIdentity)) continue
      if (globalFence) continue
      const path = this.path(jobId)
      try {
        const raw = await this.readOwnedFile(path, rootIdentity)
        const parsed = JSON.parse(decodeSaved(raw)) as Partial<ImportJob>
        if (
          parsed.jobId !== jobId ||
          typeof parsed.sourcePath !== 'string' ||
          typeof parsed.sourceName !== 'string' ||
          !Array.isArray(parsed.lines) ||
          typeof parsed.state !== 'string'
        ) {
          continue
        }
        jobs.push(parsed as ImportJob)
      } catch {
        // A corrupt or keychain-unavailable checkpoint must not block other jobs or app startup.
      }
    }
    if (!this.retentionAllowed()) return []
    return jobs
  }

  /** Boot inventories names only and requires explicit Resume for every existing checkpoint. */
  async markExistingJobsHeld(reason?: 'policy' | 'restart'): Promise<ImportHoldInventory> {
    const rootIdentity = await this.existingRoot()
    if (!rootIdentity) return { jobIds: [], policyHeldJobIds: [], inventoryOverflow: false, policyHoldOverflow: false }
    const holdReason =
      (await this.globalHoldReason(rootIdentity)) === 'policy'
        ? 'policy'
        : (reason ?? (this.retentionAllowed() ? 'restart' : 'policy'))

    const jobIds: string[] = []
    let scanned = 0
    let overflow = false
    const directory = await opendir(this.root)
    try {
      for await (const entry of directory) {
        scanned += 1
        if (scanned > MAX_HOLD_SCAN_ENTRIES) {
          overflow = true
          break
        }
        if (!entry.isFile()) continue
        const match = JOB_NAME.exec(entry.name)
        if (!match) continue
        if (jobIds.length === MAX_HELD_JOB_IDS) {
          overflow = true
          break
        }
        jobIds.push(match[1])
      }
    } finally {
      await directory.close().catch(() => {})
    }
    await this.assertRootIdentity(rootIdentity)
    jobIds.sort()

    let markerWriteFailed = false
    if (jobIds.length) {
      // Establish a crash-safe fence before materializing individual holds. It is removed only when
      // this bounded scan was complete and every discovered checkpoint now has an individual marker.
      try {
        await this.writeGlobalHold(rootIdentity, holdReason)
      } catch {
        markerWriteFailed = true
      }
      for (const jobId of jobIds) {
        try {
          await this.writeHold(jobId, rootIdentity, holdReason)
        } catch {
          markerWriteFailed = true
        }
      }
      let allMarkersValid = !markerWriteFailed && !overflow && (await this.globalHoldValid(rootIdentity))
      if (allMarkersValid) {
        for (const id of jobIds) {
          if (!(await this.markerIsValid(this.holdPath(id), id, rootIdentity))) {
            allMarkersValid = false
            break
          }
        }
      }
      if (allMarkersValid) {
        await this.assertRootIdentity(rootIdentity)
        await this.removeMarker(this.globalHoldPath())
      }
    } else if (overflow) {
      try {
        await this.writeGlobalHold(rootIdentity, holdReason)
      } catch {
        markerWriteFailed = true
      }
    } else if ((await this.globalHoldPresent(rootIdentity)) && (await this.globalHoldValid(rootIdentity))) {
      await this.assertRootIdentity(rootIdentity)
      await this.removeMarker(this.globalHoldPath())
    }

    const inventory = await this.listHeldJobIds()
    // The boot scan itself is the bounded in-memory inventory for explicit Resume. Marker writes only
    // retain the fixed reason across boots; every checkpoint already requires explicit Resume after boot.
    // If storage refuses a marker, keep the discovered IDs visible and retry marker creation next startup.
    return {
      jobIds: Array.from(new Set([...jobIds, ...inventory.jobIds])).slice(0, MAX_HELD_JOB_IDS),
      policyHeldJobIds:
        holdReason === 'policy'
          ? Array.from(new Set([...jobIds, ...inventory.policyHeldJobIds])).slice(0, MAX_HELD_JOB_IDS)
          : inventory.policyHeldJobIds,
      inventoryOverflow: overflow || markerWriteFailed || inventory.inventoryOverflow,
      policyHoldOverflow: (markerWriteFailed && holdReason === 'policy') || inventory.policyHoldOverflow
    }
  }

  /** Returns bounded, content-free hold IDs; a global fence reports overflow without inventing a count. */
  async listHeldJobIds(): Promise<ImportHoldInventory> {
    const rootIdentity = await this.existingRoot()
    if (!rootIdentity) return { jobIds: [], policyHeldJobIds: [], inventoryOverflow: false, policyHoldOverflow: false }
    const jobIds: string[] = []
    const policyHeldJobIds: string[] = []
    let scanned = 0
    let overflow = await this.globalHoldPresent(rootIdentity)
    let policyHoldOverflow = (await this.globalHoldReason(rootIdentity)) === 'policy'
    const directory = await opendir(this.root)
    try {
      for await (const entry of directory) {
        scanned += 1
        if (scanned > MAX_HOLD_SCAN_ENTRIES) {
          overflow = true
          break
        }
        const match = HOLD_NAME.exec(entry.name)
        if (!match) continue
        const jobId = match[1]
        if (!entry.isFile()) {
          overflow = true
          continue
        }
        const marker = await this.readMarker(this.holdPath(jobId), jobId, rootIdentity)
        if (!marker || !('jobId' in marker)) {
          overflow = true
          continue
        }
        if (jobIds.length === MAX_HELD_JOB_IDS) {
          overflow = true
          break
        }
        jobIds.push(jobId)
        if (marker.reason === 'policy') policyHeldJobIds.push(jobId)
      }
    } finally {
      await directory.close().catch(() => {})
    }
    await this.assertRootIdentity(rootIdentity)
    return { jobIds, policyHeldJobIds, inventoryOverflow: overflow, policyHoldOverflow }
  }

  /** Reads only the explicitly selected, already-held checkpoint after current retention is allowed. */
  async loadHeld(jobId: string, explicitResume = false): Promise<ImportJob | undefined> {
    await this.refreshAndAssertRetentionAllowed()
    this.assertRetentionAllowed()
    if (!isJobId(jobId)) throw new Error('Invalid import identity.')
    const rootIdentity = await this.existingRoot()
    await this.refreshAndAssertRetentionAllowed()
    if (!rootIdentity || (!explicitResume && !(await this.markerIsValid(this.holdPath(jobId), jobId, rootIdentity))))
      return undefined
    if (!(await this.isRegularFile(this.path(jobId)))) return undefined
    await this.refreshAndAssertRetentionAllowed()
    const raw = await this.readOwnedFile(this.path(jobId), rootIdentity)
    await this.refreshAndAssertRetentionAllowed()
    this.assertRetentionAllowed()
    const parsed = JSON.parse(decodeSaved(raw)) as Partial<ImportJob>
    if (
      parsed.jobId !== jobId ||
      typeof parsed.sourcePath !== 'string' ||
      typeof parsed.sourceName !== 'string' ||
      !Array.isArray(parsed.lines) ||
      typeof parsed.state !== 'string'
    ) {
      throw new Error('The saved import checkpoint is not valid.')
    }
    this.assertRetentionAllowed()
    return parsed as ImportJob
  }

  /** Persist a content-free policy hold only for an already-existing checkpoint. */
  async markHeld(jobId: string, reason: 'policy' | 'restart' = 'policy'): Promise<boolean> {
    if (!isJobId(jobId)) throw new Error('Invalid import identity.')
    const rootIdentity = await this.existingRoot()
    if (!rootIdentity || !(await this.isRegularFile(this.path(jobId)))) return false
    await this.writeHold(jobId, rootIdentity, reason)
    return true
  }

  async clearHold(jobId: string): Promise<void> {
    if (!isJobId(jobId)) throw new Error('Invalid import identity.')
    const rootIdentity = await this.existingRoot()
    if (!rootIdentity) return
    if (await this.markerPresent(this.holdPath(jobId), rootIdentity)) {
      await this.assertRootIdentity(rootIdentity)
      await this.removeMarker(this.holdPath(jobId))
    }
  }

  async remove(jobId: string): Promise<void> {
    if (!isJobId(jobId)) throw new Error('Invalid import identity.')
    for (const path of [this.path(jobId), this.holdPath(jobId)]) {
      await this.removeMarker(path)
    }
  }

  private retentionAllowed(): boolean {
    if (this.retentionStatus) return this.retentionStatus() === 'allowed'
    return canRetainImportedTranscript(this.getSettings())
  }

  private assertRetentionAllowed(): void {
    if (this.retentionStatus) {
      const status = this.retentionStatus()
      if (status === 'unavailable') throw new ImportRetentionAuthorityUnavailableError()
      if (status !== 'allowed') throw new ImportRetentionBlockedError()
    } else if (!this.retentionAllowed()) throw new ImportRetentionBlockedError()
  }

  private async refreshAndAssertRetentionAllowed(): Promise<void> {
    if (!this.refreshRetentionStatus) return
    const status = await this.refreshRetentionStatus()
    if (status === 'unavailable') throw new ImportRetentionAuthorityUnavailableError()
    if (status !== 'allowed') throw new ImportRetentionBlockedError()
  }

  private async ensureRoot(): Promise<RootIdentity> {
    let identity = await this.existingRoot()
    if (!identity) {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      identity = await this.existingRoot()
    }
    if (!identity) throw new Error('The import checkpoint folder is unavailable.')
    return identity
  }

  private async existingRoot(): Promise<RootIdentity | undefined> {
    try {
      const stat = await lstat(this.root)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The import checkpoint folder is not owned.')
      return { dev: stat.dev, ino: stat.ino }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async assertRootIdentity(expected: RootIdentity): Promise<void> {
    const actual = await this.existingRoot()
    if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('The import checkpoint folder changed during the operation.')
    }
  }

  private assertRootIdentityBeforeReplace(expected: RootIdentity): void {
    const stat = lstatSync(this.root)
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error('The import checkpoint folder changed during the operation.')
    }
  }

  private async readOwnedFile(path: string, root: RootIdentity): Promise<Buffer> {
    await this.assertRootIdentity(root)
    const before = await lstat(path)
    await this.refreshAndAssertRetentionAllowed()
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('The import checkpoint is not a regular file.')
    this.assertRetentionAllowed()
    const nofollow = fsConstants.O_NOFOLLOW ?? 0
    const nonblock = fsConstants.O_NONBLOCK ?? 0
    const handle = await open(path, fsConstants.O_RDONLY | nofollow | nonblock)
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) throw new Error('The import checkpoint is not a regular file.')
      const pathStat = await lstat(path)
      if (pathStat.isSymbolicLink() || pathStat.dev !== opened.dev || pathStat.ino !== opened.ino) {
        throw new Error('The import checkpoint changed during the read.')
      }
      await this.refreshAndAssertRetentionAllowed()
      this.assertRetentionAllowed()
      const bytes = await handle.readFile()
      const after = await lstat(path)
      const finalStat = await handle.stat()
      if (
        after.isSymbolicLink() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        !sameFileVersion(opened, finalStat)
      ) {
        throw new Error('The import checkpoint changed during the read.')
      }
      await this.assertRootIdentity(root)
      await this.refreshAndAssertRetentionAllowed()
      this.assertRetentionAllowed()
      return bytes
    } finally {
      await handle.close()
    }
  }

  private async readMarker(
    path: string,
    expectedJobId?: string,
    root?: RootIdentity
  ): Promise<HoldMarker | GlobalHoldMarker | undefined> {
    try {
      const verifiedRoot = root ?? (await this.existingRoot())
      if (!verifiedRoot) return undefined
      await this.assertRootIdentity(verifiedRoot)
      const before = await lstat(path)
      if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_MARKER_BYTES) return undefined
      const nofollow = fsConstants.O_NOFOLLOW ?? 0
      const nonblock = fsConstants.O_NONBLOCK ?? 0
      const handle = await open(path, fsConstants.O_RDONLY | nofollow | nonblock)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > MAX_MARKER_BYTES || !sameFileVersion(before, stat)) return undefined
        const pathStat = await lstat(path)
        if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) return undefined
        const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1)
        let length = 0
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        if (length > MAX_MARKER_BYTES) return undefined
        await this.assertRootIdentity(verifiedRoot)
        const after = await lstat(path)
        const finalStat = await handle.stat()
        if (
          after.isSymbolicLink() ||
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          !sameFileVersion(stat, finalStat) ||
          !sameFileVersion(stat, after)
        )
          return undefined
        const value = JSON.parse(bytes.toString('utf8', 0, length)) as Record<string, unknown>
        if (expectedJobId) {
          if (
            Object.keys(value).length !== 3 ||
            value.version !== 1 ||
            value.jobId !== expectedJobId ||
            (value.reason !== 'policy' && value.reason !== 'restart')
          ) {
            return undefined
          }
          return { version: 1, jobId: expectedJobId, reason: value.reason }
        }
        if (
          Object.keys(value).length !== 3 ||
          value.version !== 1 ||
          value.state !== 'overflow' ||
          (value.reason !== 'policy' && value.reason !== 'restart')
        )
          return undefined
        return { version: 1, state: 'overflow', reason: value.reason }
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  private async markerIsValid(path: string, jobId: string, root?: RootIdentity): Promise<boolean> {
    return (await this.readMarker(path, jobId, root)) !== undefined
  }

  private async markerPresent(path: string, root: RootIdentity): Promise<boolean> {
    await this.assertRootIdentity(root)
    try {
      await lstat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      return true
    }
  }

  private async globalHoldPresent(root: RootIdentity): Promise<boolean> {
    return this.markerPresent(this.globalHoldPath(), root)
  }

  private async globalHoldValid(root: RootIdentity): Promise<boolean> {
    return (await this.readMarker(this.globalHoldPath(), undefined, root)) !== undefined
  }

  private async globalHoldReason(root: RootIdentity): Promise<'policy' | 'restart' | undefined> {
    const marker = await this.readMarker(this.globalHoldPath(), undefined, root)
    return marker && 'state' in marker ? marker.reason : undefined
  }

  private async writeHold(jobId: string, root: RootIdentity, reason: 'policy' | 'restart'): Promise<void> {
    const path = this.holdPath(jobId)
    if (await this.markerPresent(path, root)) {
      const marker = await this.readMarker(path, jobId, root)
      if (!marker || !('jobId' in marker)) throw new Error('The saved import hold is not valid.')
      if (marker.reason === 'policy' || marker.reason === reason) return
    }
    await writeSaved(path, JSON.stringify({ version: 1, jobId, reason } satisfies HoldMarker), false, () => {
      this.assertRootIdentityBeforeReplace(root)
    })
  }

  private async writeGlobalHold(root: RootIdentity, reason: 'policy' | 'restart'): Promise<void> {
    const path = this.globalHoldPath()
    const existingReason = await this.globalHoldReason(root)
    if (existingReason === 'policy' || existingReason === reason) return
    await writeSaved(
      path,
      JSON.stringify({ version: 1, state: 'overflow', reason } satisfies GlobalHoldMarker),
      false,
      () => {
        this.assertRootIdentityBeforeReplace(root)
      }
    )
  }

  private async removeMarker(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async isRegularFile(path: string): Promise<boolean> {
    try {
      const stat = await lstat(path)
      return !stat.isSymbolicLink() && stat.isFile()
    } catch {
      return false
    }
  }

  private path(jobId: string): string {
    if (!isJobId(jobId)) throw new Error('Invalid import identity.')
    return join(this.root, `job-${jobId}.json`)
  }

  private holdPath(jobId: string): string {
    if (!isJobId(jobId)) throw new Error('Invalid import identity.')
    return join(this.root, `job-${jobId}.hold.json`)
  }

  private globalHoldPath(): string {
    return join(this.root, GLOBAL_HOLD_NAME)
  }
}

function isJobId(value: string): boolean {
  return new RegExp(`^${JOB_ID_PATTERN}$`).test(value)
}

function sameFileVersion(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
