/**
 * exec-file.ts — bounded asynchronous no-shell execution for existing fixed system-tool callers.
 *
 * The argv is an array and `shell` is pinned to false, so no argument is ever parsed by a shell. The callback
 * receives the child process error and optional bounded UTF-8 stdout. `code` is the exit status, or a string
 * errno when the spawn itself failed. Callers supply a fixed absolute executable and fixed argv.
 */
import { execFile } from 'node:child_process'

export type ExecFileError = Error & { code?: number | string | null }

export function execFileNoShell(
  file: string,
  args: readonly string[],
  options: { shell: false; timeout: number; windowsHide: true },
  callback: (error: ExecFileError | null, stdout?: string) => void
): void {
  execFile(file, [...args], { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout) =>
    callback(error, typeof stdout === 'string' ? stdout : undefined)
  )
}
