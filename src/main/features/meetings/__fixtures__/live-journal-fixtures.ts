import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { TranscriptLine } from '@shared/transcript-line'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from '../../../infra/security/content-key-wrap'
import { createLiveMeetingJournal, type LiveJournalKeyCustody, type LiveMeetingJournal } from '../live-meeting-journal'

/** Shared synthetic fixtures for the live meeting journal recovery tests. No real meeting text, owner or key. */

export const CAPTURE_ID = '11111111-1111-4111-8111-111111111111'
export const FRAME = '7:3'
export const OWNER_A = 'a'.repeat(64)
export const OWNER_B = 'b'.repeat(64)

export const realKeys: LiveJournalKeyCustody = {
  generate: generateContentKey,
  wrap: wrapContentKey,
  unwrap: (wrapped) => unwrapContentKey(wrapped),
  writeFile: writeWrappedKeyFile,
  readFile: readWrappedKeyFile
}

/** A committed cloud-final line; `index` makes both its identity and its time unique and ordered. */
export function cloudLine(
  startedAt: number,
  index: number,
  text = `synthetic line ${index} about the roadmap`
): TranscriptLine {
  const words = text.split(' ').map((word, position) => ({
    text: word,
    language: 'en',
    startMs: index * 5_000 + position * 100,
    endMs: index * 5_000 + position * 100 + 80
  }))
  const speech: Extract<CloudSpeechEvent, { type: 'segment' }> = {
    type: 'segment',
    captureId: CAPTURE_ID,
    captureGeneration: 2,
    sequence: index * 3,
    segment: {
      stream: { generation: 2, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision: 1,
      final: true,
      text,
      startMs: index * 5_000,
      endMs: index * 5_000 + 4_900
    },
    languages: ['en'],
    words
  }
  return { speaker: 'them', text, t: startedAt + index * 5_000, lang: 'English', speech }
}

export function makeTempDir(prefix: string): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

export interface WrittenJournal {
  journal: LiveMeetingJournal
}

/**
 * Journals `lines` for one meeting through the real session module (real key custody, real encrypted records), then
 * ends the session: the state a crashed process leaves behind. `ownerKey` null writes a signed-out meeting's journal.
 */
export async function writeJournal(options: {
  userData: string
  startedAt: number
  ownerKey: string | null
  lines: readonly TranscriptLine[]
  keys?: LiveJournalKeyCustody
}): Promise<void> {
  const bindings = new Map([[options.startedAt, { frameOwner: FRAME, ownerKey: options.ownerKey }]])
  const journal = createLiveMeetingJournal({
    userDataPath: () => options.userData,
    enabled: () => true,
    bindingOf: (startedAt) => bindings.get(startedAt) ?? null,
    authGeneration: () => 1,
    keys: options.keys ?? realKeys,
    audit: () => undefined
  })
  for (const line of options.lines) {
    const outcome = await journal.append({ startedAt: options.startedAt, frameOwner: FRAME, line })
    if (outcome.status !== 'durable') throw new Error(`fixture append refused: ${outcome.reason}`)
  }
  await journal.dispose()
}
