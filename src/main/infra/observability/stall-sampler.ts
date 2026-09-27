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
 *
 * M2-0192 red commit: this file's shape (the options/handle types) is final; startStallSampler's own
 * behaviour lands in the next commit — see stall-sampler.test.ts for the behaviour it must satisfy.
 */
import { spawn } from 'node:child_process'
import type { AuditEvent } from '../../logger'
import { collectStallCaptures } from './stall-bundle'

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
  throw new Error('M2-0192: not implemented')
}
