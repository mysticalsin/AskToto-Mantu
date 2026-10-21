import { parse, readMeetingFields } from './meeting-document'
import { readRevisionCheckpoint, REVISION_SCHEMA } from './transcript-checkpoint'

const IDENTITY_KEYS = new Map([
  ['type', 'type'],
  ['date', 'date'],
  ['transcriptrevision', 'transcriptRevision'],
  ['revisionschema', 'revisionSchema']
])

/** Whether decoded saved bytes still belong to the meeting and revision named by a durable receipt. */
export function matchesSavedReceiptIdentity(text: string, meetingStartedAt: number, revision: number): boolean {
  if (!Number.isSafeInteger(meetingStartedAt) || !Number.isSafeInteger(revision) || revision < 0) return false
  const document = parse(text)
  if (!document) return false

  const seen = new Map<string, string[]>()
  for (const line of document.lines) {
    const match = /^([a-z_]+):\s*(.*)$/i.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    if (!IDENTITY_KEYS.has(key)) continue
    const keys = seen.get(key) ?? []
    keys.push(match[1])
    seen.set(key, keys)
  }

  for (const [key, spelling] of IDENTITY_KEYS) {
    const matches = seen.get(key) ?? []
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== spelling)) return false
  }

  const fields = readMeetingFields(text)
  if (fields.type !== 'meeting-transcript' && fields.type !== 'meeting-summary') return false
  let canonicalDate: string
  try {
    canonicalDate = new Date(meetingStartedAt).toISOString()
  } catch {
    return false
  }
  if (fields.date !== canonicalDate) return false

  const hasRevision = (seen.get('transcriptrevision')?.length ?? 0) === 1
  const hasSchema = (seen.get('revisionschema')?.length ?? 0) === 1
  if (!hasRevision && !hasSchema) return revision === 0
  if (!hasRevision || !hasSchema) return false

  const rawSchema = fields.revisionSchema
  if (!rawSchema || !/^\d+$/.test(rawSchema)) return false
  const checkpoint = readRevisionCheckpoint(text)
  return checkpoint !== null && checkpoint.schema === REVISION_SCHEMA && checkpoint.revision === revision
}
