/** Explicit generation outcome. Missing means legacy/unspecified, never verified completion. */
export const RECAP_STATUSES = ['complete', 'incomplete'] as const
export type RecapStatus = typeof RECAP_STATUSES[number]

export function readRecapStatus(value: unknown): RecapStatus | undefined {
  return value === 'complete' || value === 'incomplete' ? value : undefined
}

/** Shared by IPC and direct storage callers; never serialize arbitrary provider error text. */
export function recapStatusValidationError(text: string, status: unknown): string | null {
  if (status === undefined) return null
  if (!readRecapStatus(status)) return 'Invalid summary completion status.'
  if (status === 'complete' && !text.trim()) return 'A complete summary must contain text.'
  if (/^## Full transcript/m.test(text.trim())) return 'The "## Full transcript" heading is reserved. Please rename it in your notes.'
  return null
}
