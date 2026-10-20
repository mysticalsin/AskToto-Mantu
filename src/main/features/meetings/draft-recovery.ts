import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import type { StorageGateway } from '../../infra/storage/gateway'
import { storageAt } from '../../infra/storage/meetings-storage'
import {
  decodeSavedMeetingAsync,
  recoverOrphanDrafts as promoteOrphanDrafts,
  resolveMeetingsFolder
} from '../../transcripts'
import { readMeetingFields } from './meeting-document'
import { getMeetingSpeechReadLimitBytes } from './meeting-speech'

/** `.autosave-draft-<stamp>-<ms>.md`, capturing the second-resolution stamp every saved meeting name starts with. */
const DRAFT_NAME = /^\.autosave-draft-(\d{4}-\d{2}-\d{2}_\d{6})-\d{3}\.md$/
const MEETING_TYPES = new Set(['meeting-transcript', 'meeting-summary'])

async function fieldsOf(gateway: StorageGateway, folder: string, name: string): Promise<Record<string, string> | null> {
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await gateway.read(name, maxBytes ? { maxBytes } : {})
  if (read.status !== 'ok') return null
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, join(folder, name))
  return decoded.ok ? readMeetingFields(decoded.text) : null
}

/**
 * GATE-07: one meeting identity yields exactly one saved or recovered meeting. A draft still on disk next to a
 * saved or recovered meeting with the same identity (its `date:` instant, to the millisecond) is the leftover of
 * a save whose draft cleanup never finished (killed after the save, or mid-unlink), so it is removed instead of
 * being promoted into a duplicate. Drafts that cannot be read or matched are left for promotion, as before.
 */
export async function removeSavedMeetingDrafts(
  settings: Settings,
  savedDrafts = new Set<string>()
): Promise<{ removed: number }> {
  let removed = 0
  try {
    const folder = resolveMeetingsFolder(settings)
    const gateway = storageAt(folder)
    const listing = await gateway.list('')
    if (listing.status !== 'ok') return { removed }
    for (const name of listing.names) {
      const stampPart = DRAFT_NAME.exec(name)?.[1]
      if (!stampPart) continue
      try {
        const identity = (await fieldsOf(gateway, folder, name))?.date
        if (!identity) continue
        const candidates = listing.names.filter((n) => n.startsWith(`${stampPart}-`) && n.endsWith('.md'))
        for (const candidate of candidates) {
          const fields = await fieldsOf(gateway, folder, candidate)
          if (!fields || !MEETING_TYPES.has(fields.type ?? '') || fields.date !== identity) continue
          // Exclude the matched draft from promotion even if a transient lock prevents its deletion.
          savedDrafts.add(name)
          await unlink(join(folder, name))
          removed++
          break
        }
      } catch {
        // one unreadable or locked draft never blocks the others; it is retried on the next launch
      }
    }
  } catch {
    // best effort: recovery never blocks launch
  }
  return { removed }
}

let launchResume: ((settings: Settings) => Promise<void>) | null = null

/** Binds the durable receipt resumption that launch recovery runs first; the disposer unbinds only its own. */
export function bindLaunchResume(resume: (settings: Settings) => Promise<void>): () => void {
  launchResume = resume
  return () => {
    if (launchResume === resume) launchResume = null
  }
}

/** Launch recovery: finish journaled saves, drop drafts whose meeting was already saved, then promote true orphans. */
export async function recoverOrphanDrafts(settings: Settings): Promise<{ recovered: number }> {
  await launchResume?.(settings).catch(() => undefined)
  const savedDrafts = new Set<string>()
  await removeSavedMeetingDrafts(settings, savedDrafts)
  return promoteOrphanDrafts(settings, savedDrafts)
}
