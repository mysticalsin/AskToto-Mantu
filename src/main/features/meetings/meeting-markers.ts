/**
 * Pure helpers for the durable frontmatter markers a saved meeting carries beyond its content (Q07): whether a
 * person edited the notes by hand (`recap_edited`) and which outbound pushes already landed (`crm_pushed`,
 * `clickup_pushed`, `next_steps_pushed`). The reads and writes themselves stay in recall.ts, under the per-file
 * mutation lane; nothing here touches the disk.
 */
import type { RecapStatus } from '@shared/recap-status'
import { readMeetingFields, recapSectionEndIndex } from './meeting-document'

/** A push fingerprint is a base-36 hash. It is interpolated into a YAML scalar (and, for next steps, a comma
 *  list), so anything else is refused rather than escaped. */
export const PUSH_KEY_RE = /^[a-z0-9]{1,32}$/

/** Longest `next_steps_pushed` value (characters); the oldest keys fall off first. */
const NEXT_STEPS_MARKER_MAX = 2048

/** The trimmed recap section of a saved meeting (the span recallRead parses), or '' when it has none. */
export function recapBodyOf(text: string, type: string | undefined): string {
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (!startMatch) return ''
  const afterStart = text.slice(startMatch.index! + startMatch[0].length)
  const endIdx = recapSectionEndIndex(afterStart, type)
  return (endIdx === -1 ? afterStart : afterStart.slice(0, endIdx)).trim()
}

/** Whether the saved recap carries `recap_edited: true` after this write (D4-3). A human edit (no status) sets it.
 *  A generation (a status) clears it, except when the run failed and wrote the edited text straight back: those
 *  notes are still the person's own. */
export function recapEditedAfterWrite(text: string, body: string, recapStatus: RecapStatus | undefined): boolean {
  if (recapStatus === undefined) return true
  const fm = readMeetingFields(text)
  return fm.recap_edited === 'true' && recapBodyOf(text, fm.type) === body
}

/** The valid keys of a stored comma list, in push order. */
export function parseKeyList(value: string): string[] {
  return value.split(',').filter((key) => PUSH_KEY_RE.test(key))
}

/** The `next_steps_pushed` value after recording `key`, or null when it is already recorded. Keeps push order and
 *  stays within 2 KB, dropping the oldest keys first, however many tasks a long-lived file collects. */
export function nextStepsMarkerValue(existing: string | undefined, key: string): string | null {
  const kept = parseKeyList(existing ?? '')
  if (kept.includes(key)) return null
  kept.push(key)
  while (kept.join(',').length > NEXT_STEPS_MARKER_MAX) kept.shift()
  return kept.join(',')
}
