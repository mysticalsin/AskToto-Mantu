import { exciseDeletedMeeting } from './brain/ingest'
import { publishMeetingCard } from './brain/publish'
import { purgeGraphArtifacts, scheduleRebuild } from './graphify'
import { meetingFiles } from './history-read'
import { mainLog } from './logger'
import { FILENAME_TIMESTAMP } from './meeting-privacy'
import { getSettings } from './store'
import { resolveMeetingsFolder } from './transcripts'

/** Graph hooks the retention sweep calls after it deleted something; tests inject their own. */
export interface SweepDeps {
  purgeGraph?: () => boolean
  rebuildGraph?: () => Promise<void>
}

// Filenames are always `YYYY-MM-DD_HHMMSS-<slug>.md` (see transcripts.ts) — parsed here rather than
// trusting file mtime, since mtime changes on copy/sync (this folder is often OneDrive-synced) and
// would silently corrupt age-based retention.
/** The saved meetings a `retentionDays` window would delete, by the age in their filename; none when off. */
export async function expiredMeetingFiles(retentionDays: number): Promise<string[]> {
  if (!retentionDays || retentionDays <= 0) return []
  const files = await meetingFiles(resolveMeetingsFolder(getSettings()))
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  return files.filter((file) => {
    const m = file.match(FILENAME_TIMESTAMP)
    if (!m) return false // unrecognized filename shape — never guess an age, skip rather than risk deleting the wrong file
    const [, y, mo, d, h, mi, s] = m
    const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime()
    return Number.isFinite(t) && t < cutoff
  })
}

/** How many saved meetings a retention window would delete at its next sweep (Settings asks before shortening). */
export async function countExpiredMeetings(retentionDays: number): Promise<number> {
  return (await expiredMeetingFiles(retentionDays)).length
}

/**
 * Auto-delete meetings older than `retentionDays` (storage-limitation control for recorded third-party
 * speech). `retentionDays <= 0` means retention is off — keep everything, the historical default. Swept
 * once per app launch (see index.ts). Reuses deleteMeeting per file so index.md stays row-accurate,
 * unlike the wholesale deleteAllMeetings wipe.
 */
export async function sweepExpired(
  retentionDays: number,
  deleteMeeting: (file: string) => Promise<{ ok: boolean; error?: string }>,
  deps: SweepDeps = {}
): Promise<{ deleted: number }> {
  let deleted = 0
  for (const file of await expiredMeetingFiles(retentionDays)) {
    const r = await deleteMeeting(file)
    if (r.ok) {
      deleted++
      // D4-2: the cleartext wiki note card is derived from the file just deleted; publishMeetingCard unlinks it in
      // exactly that case (and no-ops when publishing is off). publishAll only visits extractions, which the excise
      // below removes, so nothing else would ever clean the orphan card up.
      await publishMeetingCard(getSettings(), file).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        mainLog.warn(`[publish] could not remove the note card for an expired meeting: ${detail}`)
      })
      // MQA-230: same provider-free excise the interactive delete performs — the expired meeting's own
      // extraction JSON + ledger row must not wait for a source refresh that needs a usable provider.
      await exciseDeletedMeeting(getSettings(), file).catch(() => {
        /* best-effort — the sweep's caller already requests the source refresh that re-derives */
      })
    }
  }
  if (deleted > 0) {
    // D4-13: graph.json still names the deleted meetings' topics and notes. Drop it and re-derive from what remains.
    try {
      ;(deps.purgeGraph ?? purgeGraphArtifacts)()
      void (deps.rebuildGraph ?? (() => scheduleRebuild()))().catch(() => undefined)
    } catch {
      /* best-effort — a locked graph file must not fail the retention sweep */
    }
  }
  return { deleted }
}
