import { randomBytes } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { recordLocalWrite } from './local-writes'

/** Replaces one saved file only after its current owner admits the exact rename attempt. */
export async function atomicSavedWrite(file: string, data: Buffer, beforeReplace?: () => void): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, { mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      // Admission is synchronous and outside the rename retry handler so refusals propagate unchanged.
      beforeReplace?.()
      try {
        await rename(tmp, file)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // OneDrive and real-time scanners can briefly hold a new file open on Windows.
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt))
      }
    }
    await recordLocalWrite(file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}
