/**
 * exec-file.ts — a one-shot child process for a fixed system tool (M2-0429: /usr/bin/tccutil for Repair).
 *
 * The argv is an array and `shell` is pinned to false, so no argument is ever parsed by a shell. The callback
 * receives child_process.execFile's error unchanged: `code` is the exit status, or a string errno when the
 * spawn itself failed.
 */
import { execFile } from 'node:child_process'

export type ExecFileError = Error & { code?: number | string | null }

export function execFileNoShell(
  file: string,
  args: readonly string[],
  options: { shell: false; timeout: number; windowsHide: true },
  callback: (error: ExecFileError | null) => void
): void {
  execFile(file, [...args], options, (error) => callback(error))
}
