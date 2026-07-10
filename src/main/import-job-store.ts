import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlink } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { readSavedFile, writeSaved } from './transcripts'
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
    this.ensureRoot()
    await writeSaved(this.path(job.jobId), JSON.stringify(job), this.getSettings().encryptTranscripts)
  }

  async list(): Promise<ImportJob[]> {
    if (!existsSync(this.root)) return []
    const jobs: ImportJob[] = []
    for (const name of readdirSync(this.root)) {
      if (!/^job-[a-zA-Z0-9_-]+\.json$/.test(name)) continue
      const path = join(this.root, name)
      try {
        if (!statSync(path).isFile()) continue
        const raw = readSavedFile(path)
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
    await new Promise<void>((resolve, reject) => {
      unlink(this.path(jobId), (error) => {
        if (!error || (error as NodeJS.ErrnoException).code === 'ENOENT') resolve()
        else reject(error)
      })
    })
  }

  private ensureRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private path(jobId: string): string {
    return join(this.root, `job-${jobId}.json`)
  }
}
