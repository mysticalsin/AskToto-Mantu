/**
 * A cloud-STT start replaces any prior session. Re-check IPC ownership after every await so a
 * superseded handler can never start a socket after the newer owner has taken over.
 *
 * The caller owns the underlying session lifecycle. In particular, a stale handler must not call
 * a global stop method here: that could close the newer owner's active session.
 */
export async function replaceCloudSttSessionIfCurrent<Result>(input: {
  stop: () => Promise<unknown>
  isCurrent: () => boolean
  start: () => Promise<Result>
  stale: () => Result
}): Promise<Result> {
  await input.stop()
  if (!input.isCurrent()) return input.stale()

  const result = await input.start()
  return input.isCurrent() ? result : input.stale()
}

/**
 * A cloud-STT IPC request is authorized only for the capture that owns the current main-process session.
 *
 * Older renderer builds did not send a capture id. Keep that compatibility only for an owner that
 * was itself created without one; once a current owner is identity-bound, an unscoped or stale request
 * must not affect it from the same webContents.
 */
export function cloudSttRequestBelongsToOwner(
  ownerCaptureId: string | undefined,
  requestedCaptureId: unknown
): boolean {
  if (ownerCaptureId === undefined) return requestedCaptureId === undefined
  return typeof requestedCaptureId === 'string' && requestedCaptureId === ownerCaptureId
}
