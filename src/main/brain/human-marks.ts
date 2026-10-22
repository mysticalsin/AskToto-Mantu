import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import { classifyAll, storageAt } from '../infra/storage/meetings-storage'
import { mainLog } from '../logger'
import { assertMemoryOpen } from '../memory-partition/memory-access'
import { brainDir, brainRelDir } from './brain-root'
import { decodeSavedResult, resolveMeetingsFolder, writeSaved } from '../transcripts'

/**
 * Human marks sidecar (Q04 / D8-2): `.brain/human-marks.json`.
 *
 * A deal's Won/Lost outcome and a commitment's Kept/Broken status are human decisions that live only in
 * derived entity files, so every rebuild reset them to open. This sidecar records each mark when it is made.
 * purgeBrain keeps the file across a rebuild and human-marks-apply.ts re-applies it after the correction
 * replay.
 *
 * Why a sidecar and not new correction-journal kinds: a 2.11 build reading a journal with an unknown kind
 * would fail CorrectionEntrySchema and quarantine the whole journal. An older build ignores this file.
 *
 * Deliberately imports nothing from store.ts, so store.ts's purgeBrain can name the file without a cycle.
 * Callers hold withEntityLock, which is what serializes read-modify-write of this file.
 */
export const HUMAN_MARKS_FILE = 'human-marks.json'

const DealOutcomeMarkSchema = z.object({ outcome: z.enum(['open', 'won', 'lost']), at: z.string() })
const CommitmentMarkSchema = z.object({
  status: z.enum(['open', 'kept', 'broken']),
  at: z.string(),
  dealSlug: z.string().optional(),
  personSlug: z.string().optional()
})
const HumanMarksSchema = z.object({
  v: z.literal(1),
  dealOutcomes: z.record(z.string(), DealOutcomeMarkSchema),
  commitmentStatus: z.record(z.string(), CommitmentMarkSchema)
})
export type HumanMarks = z.infer<typeof HumanMarksSchema>

export const emptyHumanMarks = (): HumanMarks => ({ v: 1, dealOutcomes: {}, commitmentStatus: {} })

/** Commitment marks are keyed per deal: the same promise text on two deals is two decisions. */
export const commitmentMarkKey = (dealSlug: string, key: string): string => `${dealSlug}::${key}`

const marksPath = (s: Settings): string => join(brainDir(s), HUMAN_MARKS_FILE)

type MarksRead = { status: 'ok'; marks: HumanMarks } | { status: 'unavailable' } | { status: 'invalid' }

async function readMarks(s: Settings): Promise<MarksRead> {
  const gateway = storageAt(resolveMeetingsFolder(s))
  const rel = join(brainRelDir(), HUMAN_MARKS_FILE)
  const fileClass = (await classifyAll(gateway, [rel])).get(rel)
  if (!fileClass || fileClass.status === 'missing') return { status: 'ok', marks: emptyHumanMarks() }
  if (!('version' in fileClass) || fileClass.status !== 'ok') return { status: 'unavailable' }
  const read = await gateway.read(rel)
  if (read.status === 'missing') return { status: 'ok', marks: emptyHumanMarks() }
  if (read.status !== 'ok') return { status: 'unavailable' }
  try {
    const decoded = decodeSavedResult(read.bytes)
    if (!decoded.ok) return { status: 'invalid' }
    return { status: 'ok', marks: HumanMarksSchema.parse(JSON.parse(decoded.text)) }
  } catch {
    return { status: 'invalid' }
  }
}

/** Current marks. A file that is not readable here yet (cloud-only, another device's key) is an error so a
 *  caller never mistakes it for "no marks". An invalid file is set aside and reads as empty. */
export async function readHumanMarks(s: Settings): Promise<HumanMarks> {
  const read = await readMarks(s)
  if (read.status === 'ok') return read.marks
  if (read.status === 'unavailable') throw new Error('Human marks are not readable on this device yet.')
  const aside = join(dirname(marksPath(s)), `human-marks.corrupt-${Date.now()}.json`)
  await rename(marksPath(s), aside)
  mainLog.error('[brain] human-marks.json was unreadable; kept as a human-marks.corrupt-* copy')
  return emptyHumanMarks()
}

async function writeMarks(s: Settings, marks: HumanMarks): Promise<void> {
  assertMemoryOpen() // never create a store for an owner that is not verified and active
  await mkdir(dirname(marksPath(s)), { recursive: true })
  await writeSaved(marksPath(s), JSON.stringify(marks, null, 2), !!s.encryptTranscripts)
}

/** Record (or, for 'open', clear) a deal outcome mark. Call BEFORE mutating the entity file. */
export async function recordDealOutcomeMark(
  s: Settings,
  dealSlug: string,
  outcome: 'open' | 'won' | 'lost'
): Promise<void> {
  const marks = await readHumanMarks(s)
  if (outcome === 'open') delete marks.dealOutcomes[dealSlug]
  else marks.dealOutcomes[dealSlug] = { outcome, at: new Date().toISOString() }
  await writeMarks(s, marks)
}

/** Record (or, for 'open', clear) a commitment settlement mark. Call BEFORE mutating the entity files. */
export async function recordCommitmentMark(
  s: Settings,
  dealSlug: string,
  key: string,
  status: 'open' | 'kept' | 'broken'
): Promise<void> {
  const marks = await readHumanMarks(s)
  const k = commitmentMarkKey(dealSlug, key)
  if (status === 'open') delete marks.commitmentStatus[k]
  else marks.commitmentStatus[k] = { status, at: new Date().toISOString(), dealSlug }
  await writeMarks(s, marks)
}
