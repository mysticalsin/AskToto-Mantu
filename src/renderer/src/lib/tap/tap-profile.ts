// Desk Tap Control refuses to arm on a profile calibrated against a different microphone (the mic is part
// of the acoustic model). That refusal is a STANDING state — "paused until you recalibrate" — not an
// event, so it is derived from the same settings snapshot useTapControl reads rather than latched in
// React state. Latched, it was cleared by an effect keyed on `tapCfg?.profile`, which arrives as a fresh
// object identity from every settings read, while the hook (keyed on a stable profile string) never
// re-raised it: the warning vanished seconds after appearing and the feature went silently dead again.
// Mirrors the hook's own condition, including "no explicit device selected" never counting as a mismatch.
export function tapProfileMismatch(
  tap: { enabled: boolean; profile: { micDeviceId: string } | null } | undefined,
  micDeviceId: string | undefined
): boolean {
  return Boolean(tap?.enabled && tap.profile && micDeviceId && tap.profile.micDeviceId !== micDeviceId)
}
