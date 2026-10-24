import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MEETING_RECORD_FIELD_MAX,
  MEETING_RECORD_KINDS,
  MEETING_RECORD_MAX_ADDED,
  MEETING_RECORD_MAX_EDITS,
  MEETING_RECORD_TEXT_MAX,
  type MeetingRecordEdit
} from '@shared/meeting-record'
import { emptyRecordEdits, type RecordEdits } from './build-record'

const SIDECAR_DIR = '.meeting-records'

const field = z.string().max(MEETING_RECORD_FIELD_MAX).nullable()
const RecordEditsSchema = z
  .object({
    v: z.literal(1),
    edits: z.record(
      z.string().max(80),
      z.discriminatedUnion('op', [
        z.object({
          op: z.literal('set'),
          text: z.string().max(MEETING_RECORD_TEXT_MAX).optional(),
          owner: field.optional(),
          dueText: field.optional(),
          at: z.string()
        }),
        z.object({ op: z.literal('delete'), at: z.string() })
      ])
    ),
    added: z.array(
      z.object({
        id: z.string().max(80),
        kind: z.enum(MEETING_RECORD_KINDS),
        text: z.string().max(MEETING_RECORD_TEXT_MAX),
        owner: field,
        dueText: field,
        at: z.string()
      })
    )
  })
  .strict()

/** I/O the store needs. Defaults live in `default-deps.ts`; tests inject an in-memory map. */
export interface RecordEditsDeps {
  /** Raw bytes of a sidecar, or null when it does not exist. */
  read(path: string): Promise<Buffer | null>
  /** Decoded text, or null when the bytes cannot be decoded. */
  decode(bytes: Buffer): string | null
  write(path: string, content: string, encrypt: boolean): Promise<void>
  remove(path: string): Promise<void>
}

/** The file name is a hash of the meeting basename, so it never leaks the title. */
export function sidecarPath(folder: string, safeName: string): string {
  return join(folder, SIDECAR_DIR, `${createHash('sha256').update(safeName).digest('hex').slice(0, 32)}.json`)
}

export async function readRecordEdits(deps: RecordEditsDeps, folder: string, safeName: string): Promise<RecordEdits> {
  try {
    const bytes = await deps.read(sidecarPath(folder, safeName))
    if (!bytes) return emptyRecordEdits()
    const text = deps.decode(bytes)
    if (text === null) return emptyRecordEdits()
    const parsed = RecordEditsSchema.safeParse(JSON.parse(text))
    return parsed.success ? (parsed.data as RecordEdits) : emptyRecordEdits()
  } catch {
    return emptyRecordEdits()
  }
}

/** Apply one owner edit. False when a cap would be exceeded; the sidecar is then untouched. */
export async function applyRecordEdit(
  deps: RecordEditsDeps,
  folder: string,
  safeName: string,
  op: MeetingRecordEdit,
  encrypt: boolean,
  now: () => string = () => new Date().toISOString()
): Promise<boolean> {
  const edits = await readRecordEdits(deps, folder, safeName)
  const at = now()
  if (op.op === 'delete') {
    if (!edits.edits[op.id] && Object.keys(edits.edits).length >= MEETING_RECORD_MAX_EDITS) return false
    edits.edits[op.id] = { op: 'delete', at }
  } else if (op.op === 'set') {
    const prior = edits.edits[op.id]
    if (!prior && Object.keys(edits.edits).length >= MEETING_RECORD_MAX_EDITS) return false
    const added = edits.added.find((a) => a.id === op.id)
    if (added) {
      if (op.text !== undefined) added.text = op.text
      if (op.owner !== undefined) added.owner = op.owner
      if (op.dueText !== undefined) added.dueText = op.dueText
    } else {
      const base = prior?.op === 'set' ? prior : { op: 'set' as const, at }
      edits.edits[op.id] = {
        ...base,
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.owner !== undefined ? { owner: op.owner } : {}),
        ...(op.dueText !== undefined ? { dueText: op.dueText } : {}),
        at
      }
    }
  } else {
    if (edits.added.length >= MEETING_RECORD_MAX_ADDED) return false
    edits.added.push({
      id: `user:${randomUUID()}`,
      kind: op.kind,
      text: op.text,
      owner: op.owner ?? null,
      dueText: op.dueText ?? null,
      at
    })
  }
  await deps.write(sidecarPath(folder, safeName), JSON.stringify(edits), encrypt)
  return true
}

export async function removeRecordEdits(deps: RecordEditsDeps, folder: string, safeName: string): Promise<void> {
  await deps.remove(sidecarPath(folder, safeName))
}
