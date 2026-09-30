import { app } from 'electron'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { decodeSaved, writeSaved } from './transcripts'
import type { ImportJob, ImportJobStore } from './import-jobs'

/**
 * Encrypted-at-rest persistence for resumable imports. The app writes transcript text and the source
 * fingerprint, never decoded audio. `writeSaved` gives these checkpoints the same envelope encryption
 * behavior as saved meetings when the user has encryption enabled.
 */
export class EncryptedImportJobStore implements ImportJobStore {
  constructor(
    private readonly getSettings: () => Settings,
    private readonly root = join(app.getPath('userData'), 'import-jobs')
  ) {}

  async save(job: ImportJob): Promise<void> {
    await this.ensureRoot()
    await writeSaved(this.path(job.jobId), JSON.stringify(job), this.getSettings().encryptTranscripts)
  }

  async list(): Promise<ImportJob[]> {
    const jobs: ImportJob[] = []
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    for (const entry of entries) {
      const name = entry.name
      if (!/^job-[a-zA-Z0-9_-]+\.json$/.test(name)) continue
      if (!entry.isFile()) continue
      const path = join(this.root, name)
      try {
        const raw = decodeSaved(await readFile(path))
        const parsed = JSON.parse(raw) as Partial<ImportJob>
        if (
          typeof parsed.jobId !== 'string' ||
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
    return jobs
  }

  async remove(jobId: string): Promise<void> {
    try {
      await unlink(this.path(jobId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
  }

  private path(jobId: string): string {
    return join(this.root, `job-${jobId}.json`)
  }
}
