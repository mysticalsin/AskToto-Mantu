export type AdmittedWriteResult =
  | { kind: 'written' }
  | { kind: 'admission-refused'; error: unknown }
  | { kind: 'write-failed' }

/** Capture synchronous replacement refusals separately from ordinary storage failures. */
export function createWriteAdmissionGuard(beforeReplace: (() => void) | undefined) {
  let refusal: Extract<AdmittedWriteResult, { kind: 'admission-refused' }> | undefined
  const guard = beforeReplace
    ? () => {
        try {
          beforeReplace()
        } catch (error) {
          refusal = { kind: 'admission-refused', error }
          throw error
        }
      }
    : undefined
  return {
    guard,
    get refusal() {
      return refusal
    }
  }
}

export async function writeWithAdmission(
  beforeReplace: (() => void) | undefined,
  write: (guard: (() => void) | undefined) => Promise<void>
): Promise<AdmittedWriteResult> {
  const admission = createWriteAdmissionGuard(beforeReplace)
  try {
    await write(admission.guard)
    return { kind: 'written' }
  } catch {
    return admission.refusal ?? { kind: 'write-failed' }
  }
}
