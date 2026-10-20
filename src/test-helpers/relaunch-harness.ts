import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { RevisionEvent } from '@shared/contracts/speech/transcript-revision'
import type { SaveMeeting, Settings } from '@shared/ipc'

/** Where a meeting's end-of-meeting pipeline is killed (process exit, no cleanup). */
export type KillAt = 'after-draft-sealed' | 'after-saved-written' | 'after-ingest-queued' | 'mid-unlink'
export const KILL_STAGES: readonly KillAt[] = [
  'after-draft-sealed',
  'after-saved-written',
  'after-ingest-queued',
  'mid-unlink'
]

export interface MeetingFile {
  readonly name: string
  readonly fields: Record<string, string>
  readonly text: string
}

export interface RelaunchHarness {
  readonly folder: string
  readonly settings: Settings
  readonly meeting: SaveMeeting
  /** Pipeline stages that completed before the kill, in order. */
  readonly completed: string[]
  /** Runs one cloud-speech meeting in a fresh module graph and kills it at `killAt`. Returns the last checkpoint revision. */
  runUntilKilled(killAt: KillAt | 'never'): Promise<number>
  /** Discards all in-memory state (a new process) and runs launch recovery. */
  relaunch(): Promise<{ recovered: number }>
  /** Every saved or recovered meeting file for this meeting's identity. */
  meetings(): Promise<MeetingFile[]>
  drafts(): Promise<string[]>
  dispose(): Promise<void>
}

const final = (seq: number, language: string, text: string): RevisionEvent => ({
  kind: 'provider-final',
  relaySessionId: 'cap/1/1',
  providerSeq: seq,
  channel: 'system',
  text,
  language,
  startMs: seq * 1000,
  endMs: seq * 1000 + 900
})

/** Real files on a temp meetings root (or `sharedFolder`, left for its owner to remove) and real modules; each "process" is a fresh module graph via vi.resetModules. */
export async function createRelaunchHarness(startedAt: number, sharedFolder?: string): Promise<RelaunchHarness> {
  const folder = sharedFolder ?? (await mkdtemp(join(tmpdir(), 'metis-relaunch-')))
  const settings = { meetingsFolder: folder, autoSaveTranscripts: true } as Settings
  const meeting: SaveMeeting = {
    title: 'Planning',
    mode: 'meeting',
    startedAt,
    lines: [
      { speaker: 'them', text: 'Shall we ship on Friday?', t: startedAt },
      { speaker: 'you', text: 'Friday works.', t: startedAt + 1000 }
    ],
    recap: ''
  }
  const completed: string[] = []

  const freshProcess = async () => {
    vi.resetModules()
    const storage = await import('../main/infra/storage/meetings-storage')
    storage.useStorageForTests()
    return {
      transcripts: await import('../main/transcripts'),
      writeState: await import('../main/infra/storage/draft-transcript-write-state'),
      store: await import('../main/features/meetings/transcript-revision-store'),
      checkpoint: await import('../main/features/meetings/transcript-checkpoint-main'),
      binding: await import('../main/features/meetings/transcript-checkpoint-binding'),
      recovery: await import('../main/features/meetings/draft-recovery'),
      document: await import('../main/features/meetings/meeting-document')
    }
  }

  return {
    folder,
    settings,
    meeting,
    completed,
    async runUntilKilled(killAt) {
      const p = await freshProcess()
      const store = p.store.createTranscriptRevisionStore({ checkpointWriter: p.checkpoint.writeTranscriptCheckpoint })
      p.binding.bindTranscriptCheckpointStore(store)
      // What the draft IPC handler does: the autosave, then one checkpoint after a saved receipt.
      const autosave = async () => {
        const result = await p.transcripts.saveDraftTranscript(settings, meeting)
        if (result.status === 'saved') await p.binding.checkpointAfterDraftSave(startedAt)
      }
      // A signed-out meeting on one renderer frame (processId:routingId); the owner policy is not under test here.
      const binding = { meetingStartedAt: startedAt, frameOwner: '12:3' as const, owner: null }
      store.open(binding)
      store.apply(binding, final(0, 'en-US', 'Shall we ship on Friday?'))
      await autosave()
      store.apply(binding, final(1, 'fr', 'Vendredi.'))
      await autosave()
      completed.push('draft-autosaved')
      store.finalize(binding)
      const sealed = await store.checkpoint(startedAt)
      if (!sealed.ok) throw new Error(`final draft checkpoint failed: ${sealed.error}`)
      completed.push('draft-sealed')
      if (killAt === 'after-draft-sealed') return sealed.revision
      const file = await p.transcripts.saveMeeting(settings, meeting)
      completed.push('saved-written')
      if (killAt === 'after-saved-written') return sealed.revision
      completed.push('ingest-queued')
      if (killAt === 'after-ingest-queued') return sealed.revision
      // Cleanup seals the identity before its unlink; the kill lands between the two.
      void p.writeState.finalizeDraftMeeting(startedAt, [])
      if (!p.writeState.isDraftMeetingFinalized(startedAt)) throw new Error('cleanup did not seal the meeting')
      completed.push('cleanup-sealed')
      if (killAt === 'mid-unlink') return sealed.revision
      await p.transcripts.clearDraftTranscript(settings, startedAt, file)
      completed.push('draft-cleaned')
      return sealed.revision
    },
    async relaunch() {
      const p = await freshProcess()
      return p.recovery.recoverOrphanDrafts(settings)
    },
    async meetings() {
      const p = await freshProcess()
      const identity = new Date(startedAt).toISOString()
      const out: MeetingFile[] = []
      for (const name of await readdir(folder)) {
        if (name.startsWith('.') || !name.endsWith('.md') || name === 'index.md') continue
        const text = p.transcripts.readSavedFile(join(folder, name))
        const fields = p.document.readMeetingFields(text)
        if ((fields.type === 'meeting-transcript' || fields.type === 'meeting-summary') && fields.date === identity) {
          out.push({ name, fields, text })
        }
      }
      return out
    },
    async drafts() {
      return (await readdir(folder)).filter((name) => name.startsWith('.autosave-draft-'))
    },
    async dispose() {
      if (sharedFolder === undefined) await rm(folder, { recursive: true, force: true })
    }
  }
}

/** Raw bytes of a meeting file, for proving a completed stage was not repeated. */
export function readRaw(folder: string, name: string): Promise<Buffer> {
  return readFile(join(folder, name))
}
