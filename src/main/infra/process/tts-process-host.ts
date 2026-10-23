/**
 * tts-process-host.ts — the only place the text-to-speech children are spawned (G27, FF-10).
 *
 * The platform voice runs in a short-lived child: `metis-mac-helper speak` on macOS, a fixed PowerShell script on
 * Windows. The text to speak goes in on stdin and never in argv or a command string, so no character of an answer can
 * be parsed by a shell. argv is an array, `shell` is never set, the window is hidden, stdout is split into bounded
 * lines and stderr is not read. A kill is immediate (SIGTERM) and is backed by a SIGKILL after a fixed bound, which
 * is what makes barge-in latency bounded even when a child ignores the first signal.
 *
 * The caller decides what a line means and when to stop; the playback generation lives in the feature, not here.
 */
import { spawn, type SpawnOptions } from 'node:child_process'

/** Text longer than this is refused before any process starts. The feature caps answers far below it. */
export const MAX_TTS_STDIN_CHARS = 32_000
/** A kill that has not ended the child after this long is escalated to SIGKILL. */
export const TTS_FORCE_KILL_AFTER_MS = 250
/** A line longer than this is not part of the protocol. It is dropped instead of buffered. */
export const MAX_TTS_LINE_CHARS = 256
/** One-shot (voice list) output is bounded. */
export const MAX_TTS_PROBE_CHARS = 128 * 1024

export interface TtsProcessSpec {
  readonly command: string
  readonly args: readonly string[]
  /** Extra environment values (the Windows voice name and rate travel here, never in a command string). */
  readonly env?: Readonly<Record<string, string>>
  /** The text for the child's stdin. Empty for a one-shot that reads nothing. */
  readonly stdin: string
}

export interface TtsProcessExit {
  readonly code: number | null
  readonly signal: string | null
  /** Present when the spawn itself failed, or the text was refused. */
  readonly error?: string
}

export interface TtsProcessHandlers {
  onLine(line: string): void
  onExit(info: TtsProcessExit): void
}

export interface TtsProcessHandle {
  /** Idempotent. After it returns no callback fires again. */
  kill(): void
}

export interface TtsProbeResult {
  readonly ok: boolean
  readonly stdout: string
}

/** The port the speech feature talks to. The real one is below; tests supply a fake. */
export interface TtsProcessPort {
  start(spec: TtsProcessSpec, handlers: TtsProcessHandlers): TtsProcessHandle
  probe(spec: TtsProcessSpec, timeoutMs: number): Promise<TtsProbeResult>
}

/** The slice of ChildProcess this host uses, so tests can supply a fake. */
export interface TtsChild {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stdin: Pick<NodeJS.WritableStream, 'write' | 'end' | 'on'> | null
  on(event: 'exit' | 'close', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => TtsChild

export interface TtsProcessHostOptions {
  readonly spawn?: SpawnFn
  /** Defaults to process.env. */
  readonly baseEnv?: NodeJS.ProcessEnv
  readonly setTimeout?: (run: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void
}

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], options)

export function createTtsProcessHost(options: TtsProcessHostOptions = {}): TtsProcessPort {
  const doSpawn = options.spawn ?? defaultSpawn
  const arm = options.setTimeout ?? ((run, ms) => setTimeout(run, ms))
  const disarm = options.clearTimeout ?? ((handle) => clearTimeout(handle))

  const launch = (spec: TtsProcessSpec): { child: TtsChild } | { error: string } => {
    if (spec.stdin.length > MAX_TTS_STDIN_CHARS) return { error: 'text_too_long' }
    try {
      const spawnOptions: SpawnOptions = { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      if (spec.env) spawnOptions.env = { ...(options.baseEnv ?? process.env), ...spec.env }
      const child = doSpawn(spec.command, spec.args, spawnOptions)
      const stdin = child.stdin
      if (stdin) {
        stdin.on('error', () => {
          // The child already exited; its exit is reported through the normal path.
        })
        if (spec.stdin) stdin.write(spec.stdin, 'utf8')
        stdin.end()
      }
      return { child }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'spawn_failed' }
    }
  }

  return {
    start(spec, handlers) {
      const launched = launch(spec)
      if ('error' in launched) {
        handlers.onExit({ code: null, signal: null, error: launched.error })
        return { kill() {} }
      }
      const { child } = launched
      let killed = false
      let exited = false
      let buffer = ''
      let discarding = false
      let forceTimer: NodeJS.Timeout | null = null

      const deliver = (line: string): void => {
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
          else if (line.length <= MAX_TTS_LINE_CHARS) deliver(line)
          newline = buffer.indexOf('\n')
        }
        if (buffer.length > MAX_TTS_LINE_CHARS) {
          buffer = ''
          discarding = true
        }
      }
      const finish = (info: TtsProcessExit, processExited = false): void => {
        if (exited) return
        if (!processExited && killed) return
        exited = true
        if (forceTimer) {
          disarm(forceTimer)
          forceTimer = null
        }
        if (!killed) handlers.onExit(info)
      }

      const stdout = child.stdout
      if (stdout) {
        if ('setEncoding' in stdout && typeof stdout.setEncoding === 'function') stdout.setEncoding('utf8')
        stdout.on('data', (chunk: string | Buffer) => take(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
      }
      child.on('error', (error: Error) => finish({ code: null, signal: null, error: error.message }))
      child.on('exit', (code, signal) => finish({ code, signal }, true))
      child.on('close', (code, signal) => finish({ code, signal }, true))

      return {
        kill() {
          if (killed) return
          killed = true
          buffer = ''
          try {
            child.kill('SIGTERM')
          } catch {
            // Already gone.
          }
          if (exited) return
          forceTimer = arm(() => {
            forceTimer = null
            if (exited) return
            try {
              child.kill('SIGKILL')
            } catch {
              // Already gone.
            }
          }, TTS_FORCE_KILL_AFTER_MS)
        }
      }
    },

    probe(spec, timeoutMs) {
      return new Promise<TtsProbeResult>((resolve) => {
        const launched = launch(spec)
        if ('error' in launched) return resolve({ ok: false, stdout: '' })
        const { child } = launched
        let settled = false
        let closed = false
        let timedOut = false
        let stdout = ''
        let timer: NodeJS.Timeout | null = null
        let forceTimer: NodeJS.Timeout | null = null
        const settle = (ok: boolean): void => {
          if (settled) return
          settled = true
          if (timer) disarm(timer)
          resolve({ ok, stdout })
        }
        const close = (ok: boolean): void => {
          closed = true
          if (forceTimer) disarm(forceTimer)
          forceTimer = null
          settle(ok)
        }
        timer = arm(() => {
          timer = null
          timedOut = true
          try {
            child.kill('SIGTERM')
          } catch {
            // Already gone.
          }
          forceTimer = arm(() => {
            forceTimer = null
            if (closed) return
            try {
              child.kill('SIGKILL')
            } catch {
              // Already gone.
            }
          }, TTS_FORCE_KILL_AFTER_MS)
          settle(false)
        }, timeoutMs)
        const out = child.stdout
        if (out) {
          if ('setEncoding' in out && typeof out.setEncoding === 'function') out.setEncoding('utf8')
          out.on('data', (chunk: string | Buffer) => {
            if (stdout.length >= MAX_TTS_PROBE_CHARS) return
            stdout = (stdout + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).slice(
              0,
              MAX_TTS_PROBE_CHARS
            )
          })
        }
        child.on('error', () => {
          // An error after SIGTERM does not prove the child exited; wait for close before canceling escalation.
          if (timedOut) settle(false)
          else close(false)
        })
        // `close`, not `exit`: only after it can the last of stdout have been read.
        child.on('close', (code) => close(code === 0))
      })
    }
  }
}

/** The production host. */
export const ttsProcessHost: TtsProcessPort = createTtsProcessHost()
