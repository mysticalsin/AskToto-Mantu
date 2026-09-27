/**
 * stall-bundle.ts — turns a raw /usr/bin/sample capture of a stalled main process into a content-free
 * bundle and keeps the newest MAX_BUNDLES of them (M2-0192, ARCHITECTURE C15).
 *
 * `metis-mac-helper stall-watch` (see stall-sampler.ts) writes each capture into captureDir() as
 * `<bootId>.<capturedAtMs>.<stalledMs>.sample`. A capture is the full sample(1) report, which names the
 * app's install path and every loaded image's path, so it never leaves captureDir():
 * collectStallCaptures() projects it into a bundle and deletes it, whether or not the projection succeeds.
 *
 * The projection is an allowlist, not a scrub. Only the call graph's thread headers and frame lines
 * survive, each rebuilt from parsed fields: sample count, symbol name, image name and offset. The report
 * header, thread and queue names, source file:line, the summary sections and Binary Images are dropped. A
 * symbol or image name holding `/`, `\`, `@` or a control character becomes `<redacted>`, so no bundle
 * contains any of those characters and no path or email can survive. Symbol and image names come from the
 * symbol tables of loaded code, never from user data.
 *
 * M2-0192 red commit: this file's shape (types, constants, the two pure path helpers) is final; the
 * projection and collection logic land in the next commit — see stall-bundle.test.ts for the behaviour
 * they must satisfy.
 */
import { join } from 'node:path'

/** Bundles kept; the oldest capture is dropped first. */
export const MAX_BUNDLES = 10
/** Stack bytes kept per bundle. The main thread is written first, so the cut never drops it. */
export const MAX_BUNDLE_BYTES = 512 * 1024

/** One capture's fate, for the caller to audit. `bootId` is the boot that stalled; after a relaunch that
 *  is not the current boot. `bundle` is a file name inside bundleDir(). */
export type CaptureOutcome =
  | { kind: 'bundled'; bootId: string; stalledMs: number; bundle: string }
  | { kind: 'failed'; bootId: string }

export function bundleDir(userData: string): string {
  return join(userData, 'diagnostics', 'stalls')
}

export function captureDir(userData: string): string {
  return join(bundleDir(userData), 'raw')
}

/** The call graph of a sample(1) report as thread stacks and symbol names only, main thread first. Pure.
 *  Empty when the report has no call-graph thread (for example sample's own error text). */
export function projectSample(report: string): string[] {
  throw new Error('M2-0192: not implemented')
}

/** Turn every pending capture into a bundle or a failure, delete it either way, then keep the newest
 *  MAX_BUNDLES bundles. Never rejects; a missing capture directory is nothing to do. */
export async function collectStallCaptures(userData: string): Promise<CaptureOutcome[]> {
  throw new Error('M2-0192: not implemented')
}
