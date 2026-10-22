/**
 * line-helper-host.ts — one long-running helper child that speaks newline-delimited text on stdout (V01).
 *
 * This is the only place the voice hold-chord helper is spawned (FF-10: process spawning lives in
 * src/main/infra/process/). It is deliberately dumb: argv goes to the OS directly with no shell, stdin and stderr are
 * not piped, stdout is split into lines with a hard bound on a single line, and the caller decides what a line means
 * and what to do when the child dies. Lifecycle policy (enable gating, backoff, kill on lock/sign-out/quit) lives in
 * src/main/voice/chord-watcher.ts.
 */
import { spawn, type SpawnOptions } from 'node:child_process'

/** A line longer than this is not part of any protocol we speak. It is dropped instead of buffered. */
export const MAX_HELPER_LINE_CHARS = 256

export interface LineHelperSpec {
  readonly command: string
  readonly args: readonly string[]
}

export interface LineHelperExit {
  readonly code: number | null
  readonly signal: string | null
  /** Present when the spawn itself failed (ENOENT, EACCES); Node then emits `error` and never `exit`. */
  readonly error?: string
}

export interface LineHelperHandlers {
  onLine(line: string): void
  onExit(info: LineHelperExit): void
}

export interface LineHelperHandle {
  /** Idempotent. After it returns no callback fires again. */
  kill(): void
}

/** The slice of ChildProcess this host uses, so tests can supply a fake. */
export interface LineHelperChild {
  readonly stdout: NodeJS.ReadableStream | null
  on(event: 'exit' | 'close', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(): boolean
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => LineHelperChild

export interface LineHelperHostOptions {
  readonly spawn?: SpawnFn
}

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], options)

/**
 * Start the helper. Throws whatever the spawn throws; the caller owns the retry policy.
 */
export function spawnLineHelper(
  spec: LineHelperSpec,
  handlers: LineHelperHandlers,
  options: LineHelperHostOptions = {}
): LineHelperHandle {
  const child = (options.spawn ?? defaultSpawn)(spec.command, spec.args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })

  let killed = false
  let exited = false
  let buffer = ''
  let discarding = false

  const deliverLine = (line: string): void => {
    try {
      handlers.onLine(line)
    } catch {
      // A broken consumer must not take the stream down with it.
    }
  }

  const take = (chunk: string): void => {
    if (killed) return
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (discarding) discarding = false
      else if (line.length <= MAX_HELPER_LINE_CHARS) deliverLine(line)
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_HELPER_LINE_CHARS) {
      buffer = ''
      discarding = true
    }
  }

  const finish = (info: LineHelperExit): void => {
    if (killed || exited) return
    exited = true
    handlers.onExit(info)
  }

  const stdout = child.stdout
  if (stdout) {
    if ('setEncoding' in stdout && typeof stdout.setEncoding === 'function') stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string | Buffer) => take(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
  }
  child.on('error', (error: Error) => finish({ code: null, signal: null, error: error.message }))
  child.on('exit', (code, signal) => finish({ code, signal }))
  child.on('close', (code, signal) => finish({ code, signal }))

  return {
    kill() {
      if (killed) return
      killed = true
      buffer = ''
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
  }
}
