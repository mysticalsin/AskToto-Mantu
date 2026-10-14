import type { PrepareSavedReplacement } from './atomic-saved-write'

export type AdmittedWriteResult =
  | { kind: 'written' }
  | { kind: 'admission-refused'; error: unknown }
  | { kind: 'write-failed' }

export async function writeWithAdmission(
  beforeReplace: (() => void) | undefined,
  write: (guard: (() => void) | undefined, prepare: PrepareSavedReplacement | undefined) => Promise<void>,
  prepareReplace?: PrepareSavedReplacement
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
  const prepare = prepareReplace
    ? async () => {
        try {
          const prepared = await prepareReplace()
          if (!prepared) return undefined
          return () => {
            try {
              prepared()
            } catch (error) {
              admissionFailed = true
              admissionError = error
              throw error
            }
          }
        } catch (error) {
          admissionFailed = true
          admissionError = error
          throw error
        }
      }
    : undefined
  try {
    await write(guard, prepare)
    return { kind: 'written' }
  } catch {
    return admissionFailed ? { kind: 'admission-refused', error: admissionError } : { kind: 'write-failed' }
  }
}
