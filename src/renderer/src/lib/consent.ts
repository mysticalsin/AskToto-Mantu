export const REMINDER_TTL_MS = 24 * 60 * 60 * 1000
export const AUTO_DISMISS_MS = 6000

export function shouldShowConsentReminder(
  nowMs: number,
  lastReminderAt: number,
  requireIndicator: boolean
): boolean {
  if (requireIndicator) return true
  return nowMs - lastReminderAt > REMINDER_TTL_MS
}
