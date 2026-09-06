import type { ImportAudioPickResult, ImportAudioPickedFile, ImportJobView } from '@shared/ipc'

const ACTIVE: ReadonlySet<ImportJobView['state']> = new Set([
  'decoding',
  'transcribing',
  'saving',
  'recapping'
])

const RANK: Record<ImportJobView['state'], number> = {
  decoding: 0,
  transcribing: 0,
  saving: 0,
  recapping: 0,
  queued: 1,
  failed: 2,
  done: 3,
  cancelled: 4
}

/** Tokens the renderer may start — never paths. */
export function pickedFiles(result: ImportAudioPickResult): ImportAudioPickedFile[] {
  if (result.files?.length) return result.files
  if (result.token) {
    return [
      {
        token: result.token,
        name: result.name || 'Recording',
        sizeBytes: result.sizeBytes ?? 0,
        mtimeMs: result.mtimeMs ?? 0
      }
    ]
  }
  return []
}

export function skippedImportMessage(result: ImportAudioPickResult): string | null {
  if (!result.skipped?.length) return result.error || null
  const lines = result.skipped.map((s) => `${s.name}: ${s.error}`)
  if (result.error && !result.files?.length && !result.token) return result.error
  return lines.join(' ')
}

/** Cancelled jobs stay out of the queue. Done stays until the user dismisses it. */
export function visibleImportJobs(jobs: ImportJobView[]): ImportJobView[] {
  return jobs
    .filter((job) => job.state !== 'cancelled')
    .slice()
    .sort((a, b) => {
      const rank = RANK[a.state] - RANK[b.state]
      if (rank !== 0) return rank
      return b.updatedAt - a.updatedAt
    })
}

export function importQueueHeadline(jobs: ImportJobView[]): string {
  const visible = visibleImportJobs(jobs)
  if (!visible.length) return ''
  const done = visible.filter((j) => j.state === 'done').length
  const failed = visible.filter((j) => j.state === 'failed').length
  const active = visible.filter((j) => ACTIVE.has(j.state) || j.state === 'queued').length
  const n = visible.length
  const meeting = n === 1 ? 'meeting' : 'meetings'
  if (active > 0 && done === 0 && failed === 0) {
    return n === 1 ? `Importing ${visible[0].title}` : `Importing ${n} ${meeting}`
  }
  if (done === n) return n === 1 ? 'Meeting ready' : `${n} meetings ready`
  if (failed && !active) {
    return failed === 1 ? '1 meeting needs attention' : `${failed} meetings need attention`
  }
  if (done > 0) return `${done} of ${n} ready`
  return n === 1 ? 'Importing 1 meeting' : `Importing ${n} ${meeting}`
}

export function isImportDropFile(file: { type?: string; name?: string }): boolean {
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('audio/') || type.startsWith('video/')) return true
  const name = (file.name || '').toLowerCase()
  return /\.(wav|mp3|m4a|aac|ogg|flac|aiff|aif|webm|opus|wma|amr|3gp|mp4|mov|m4v|mkv)$/.test(name)
}
