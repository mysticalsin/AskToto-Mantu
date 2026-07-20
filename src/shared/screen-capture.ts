/**
 * Permission failures must never degrade a requested visual ask into a text-only ask. Keep the
 * classifier shared so the main process and renderer agree on both macOS and Windows recovery copy.
 */
export function isScreenCapturePermissionError(message: string): boolean {
  return /screen recording permission|screen[- ]capture permissions?|screen recording.*(?:denied|off|not granted)|screen[- ]capture.*(?:denied|not granted)|granted screen recording just now|quit and reopen m[eé]tis/i.test(message)
}

/**
 * The "already granted, but this process never saw it" case: macOS only applies a fresh Screen Recording
 * grant to the NEXT launch, so a same-session retry keeps failing with an empty source list even though
 * System Settings shows it as on. Distinct from a genuine off/denied permission (isScreenCapturePermissionError
 * covers both) because the fix here is a relaunch, not another trip to System Settings.
 */
export function needsAppRelaunchForScreenCapture(message: string): boolean {
  return /granted screen recording just now|quit and reopen m[eé]tis/i.test(message)
}
