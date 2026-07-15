/**
 * Permission failures must never degrade a requested visual ask into a text-only ask. Keep the
 * classifier shared so the main process and renderer agree on both macOS and Windows recovery copy.
 */
export function isScreenCapturePermissionError(message: string): boolean {
  return /screen recording permission|screen[- ]capture permissions?|screen recording.*(?:denied|off|not granted)|screen[- ]capture.*(?:denied|not granted)|quit and reopen m[eé]tis/i.test(message)
}
