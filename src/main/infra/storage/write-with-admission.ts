export type AdmittedWriteResult =
  | { kind: 'written' }
  | { kind: 'admission-refused'; error: unknown }
  | { kind: 'write-failed' }

export async function writeWithAdmission(
  beforeReplace: (() => void) | undefined,
  write: (guard: (() => void) | undefined) => Promise<void>
): Promise<AdmittedWriteResult> {
  let admissionFailed = false
  let admissionError: unknown
  const guard = beforeReplace
    ? () => {
        try {
          beforeReplace()
        } catch (error) {
          admissionFailed = true
          admissionError = error
          throw error
        }
      }
    : undefined
  try {
    await write(guard)
    return { kind: 'written' }
  } catch {
    return admissionFailed ? { kind: 'admission-refused', error: admissionError } : { kind: 'write-failed' }
  }
}
