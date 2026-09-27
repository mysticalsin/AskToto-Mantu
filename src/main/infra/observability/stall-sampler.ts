/**
 * stall-sampler.ts — this boot's out-of-process stall sampler (M2-0192, ARCHITECTURE C15, ADR-023).
 *
 * A blocked main thread cannot report its own stall, so `metis-mac-helper stall-watch` watches
 * run-alive.json from outside. When the marker has gone unchanged for more than `aliveIntervalMs + 10 s`
 * of awake time (its rewrite is more than 10 s overdue), the helper runs /usr/bin/sample on this process,
 * once per stall and at most once per 10 minutes, writes the capture into stall-bundle.ts's captureDir(),
 * and prints one word on stdout:
 *   sampled   a capture is ready
 *   failed    /usr/bin/sample failed or overran its deadline; nothing was left behind
 * The word waits in the pipe until this thread is free again; stall-bundle.ts then turns every pending
 * capture into a content-free bundle and this module audits each outcome.
 *
 * Ownership: the helper samples only its parent, never signals it, and exits within one 5 s poll of the
 * parent dying (or, if a sample is in flight, when that sample finishes). stop() kills it on a clean quit.
 * It is never restarted: a helper that dies is audited once and this boot runs without a sampler.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runAlivePath } from '../../boot-sentinel'
import type { AuditEvent } from '../../logger'
import { captureDir, collectStallCaptures, type CaptureOutcome } from './stall-bundle'

/** The ticket's "more than 10 s stale": how far past its scheduled rewrite the marker must be. */
const OVERDUE_MS = 10_000

type SampleFailure = 'sample' | 'bundle' | 'watcher'

export interface StallSamplerOptions {
  /** The metis-mac-helper binary. */
  command: string
  userData: string
  bootId: string
  /** How often the caller rewrites run-alive.json. */
  aliveIntervalMs: number
  audit: (event: AuditEvent, detail?: Record<string, unknown>) => void
  /** Test seams only; production uses the real spawn and collector. */
  deps?: { spawn?: typeof spawn; collect?: typeof collectStallCaptures }
}

export interface StallSampler {
  /** Kill the helper and ignore anything it prints afterwards. Captures already being bundled still
   *  finish and are audited. Idempotent. */
  stop(): void
}

export function startStallSampler(opts: StallSamplerOptions): StallSampler {
  const collect = opts.deps?.collect ?? collectStallCaptures
  let stopped = false
  let watcherGone = false
  let collecting: Promise<void> = Promise.resolve()

  const auditFailure = (bootId: string, reason: SampleFailure): void =>
    opts.audit('app.stall.sample_failed', { bootId, reason })
  const auditOutcome = (outcome: CaptureOutcome): void => {
    if (outcome.kind === 'bundled') {
      opts.audit('app.stall.sampled', { bootId: outcome.bootId, stalledMs: outcome.stalledMs, bundle: outcome.bundle })
    } else {
      auditFailure(outcome.bootId, 'bundle')
    }
  }
  // One collection at a time: two running at once would each bundle and audit the same capture.
  const collectCaptures = (): void => {
    collecting = collecting.then(async () => {
      for (const outcome of await collect(opts.userData)) auditOutcome(outcome)
    })
  }
  const onWatcherGone = (): void => {
    if (stopped || watcherGone) return
    watcherGone = true
    auditFailure(opts.bootId, 'watcher')
  }

  // A previous run killed mid-stall leaves its capture behind; bundle it under that run's bootId.
  collectCaptures()

  const child = spawnWatcher(opts)
  if (!child) {
    onWatcherGone()
    return { stop: () => void (stopped = true) }
  }
  child.once('error', onWatcherGone)
  child.once('close', onWatcherGone)
  let partial = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (stopped) return
      if (line === 'sampled') collectCaptures()
      else if (line === 'failed') auditFailure(opts.bootId, 'sample')
    }
  })
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      child.kill('SIGKILL')
    }
  }
}

function spawnWatcher(opts: StallSamplerOptions): ChildProcess | undefined {
  const doSpawn = opts.deps?.spawn ?? spawn
  try {
    mkdirSync(captureDir(opts.userData), { recursive: true, mode: 0o700 })
    return doSpawn(
      opts.command,
      [
        'stall-watch',
        '--pid', String(process.pid),
        '--alive', runAlivePath(opts.userData),
        '--capture-prefix', join(captureDir(opts.userData), opts.bootId),
        '--stale-after-ms', String(opts.aliveIntervalMs + OVERDUE_MS)
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
  } catch {
    return undefined
  }
}
