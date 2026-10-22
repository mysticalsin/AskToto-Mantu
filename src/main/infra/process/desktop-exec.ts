/**
 * desktop-exec.ts: the only way the desktop adapters start a process (V03, FF-10).
 *
 * Every call is `execFile` or `spawn` with an argv array and `shell: false`, so no argument is ever parsed by a
 * shell. The caller names a fixed executable; spoken text can only ever be an element of the argv array.
 * Failure details are reduced to booleans and a bounded stderr string. A thrown value is never forwarded: its
 * message and properties may carry private output, and reading it must not be able to throw either.
 */
import { execFile, spawn } from 'node:child_process'

export interface DesktopExecResult {
  /** Exit status 0. False for a non-zero exit, a timeout, a signal or a process that never started. */
  ok: boolean
  stdout: string
  /** Bounded, for matching a known error code only. Never surface it. */
  stderr: string
  timedOut: boolean
}

export type DesktopExec = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<DesktopExecResult>

/** Resolves once the process exists. `ok` is false when it could not be created. It never waits for exit. */
export type DesktopSpawnGui = (file: string, args: readonly string[]) => Promise<{ ok: boolean }>

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BUFFER_BYTES = 1024 * 1024
const STDERR_KEEP_CHARS = 2_000

const asText = (value: unknown, keep: number): string => (typeof value === 'string' ? value.slice(0, keep) : '')

export const runDesktopExec: DesktopExec = (file, args, options) =>
  new Promise((resolve) => {
    const failed: DesktopExecResult = { ok: false, stdout: '', stderr: '', timedOut: false }
    try {
      execFile(
        file,
        [...args],
        {
          shell: false,
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          let timedOut = false
          if (error) {
            try {
              timedOut = (error as { killed?: unknown }).killed === true
            } catch {
              timedOut = false
            }
          }
          resolve({
            ok: error === null,
            stdout: asText(stdout, MAX_BUFFER_BYTES),
            stderr: asText(stderr, STDERR_KEEP_CHARS),
            timedOut
          })
        }
      )
    } catch {
      resolve(failed)
    }
  })

export const spawnDesktopGui: DesktopSpawnGui = (file, args) =>
  new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve({ ok })
    }
    try {
      const child = spawn(file, [...args], { detached: false, shell: false, stdio: 'ignore', windowsHide: true })
      child.once('error', () => finish(false))
      child.once('spawn', () => {
        child.unref()
        finish(true)
      })
    } catch {
      finish(false)
    }
  })
