import { chmod } from 'node:fs/promises'

/**
 * A decrypted copy handed to the OS is not connected to the saved meeting and is deleted at quit: take the write bit
 * away so an editor warns before taking an edit that would silently vanish. POSIX only (a read-only attribute would
 * make the quit-time unlink fail on Windows). Best effort: a failed chmod leaves the copy writable, as before.
 */
export async function makeDisposableCopyReadOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, 0o400).catch(() => undefined)
}
