#!/usr/bin/env node
/**
 * qa-dirs.mjs — the one place gates.mjs, preview.mjs, preview-tokens.mjs, preview-motion.mjs,
 * seed-local.mjs and screenshot.mjs get their preview/scratch directory from. preview.mjs writes
 * into it; gates.mjs and screenshot.mjs read what preview.mjs wrote, so all six must agree on the
 * same default without copying it six times.
 *
 * Both default to the same os.tmpdir()-based root: nothing here is tied to one machine, one user
 * or one agent session, so it runs the same way in CI, on any teammate's Mac, or on Linux.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_ROOT = join(tmpdir(), 'metis-operator-preview')

/** Directory preview.mjs, preview-tokens.mjs and preview-motion.mjs render HTML into, and
 *  gates.mjs / screenshot.mjs read from. Override with METIS_QA_PREVIEW_DIR. */
export function resolvePreviewDir(env = process.env) {
  return env.METIS_QA_PREVIEW_DIR || DEFAULT_ROOT
}

/** Scratch working directory for esbuild-tmp bundle output, seed-local's fixture.sql and
 *  screenshot's shots/npmcache. Override with METIS_QA_SCRATCH. Same default root as
 *  resolvePreviewDir() unless overridden independently. */
export function resolveScratchDir(env = process.env) {
  return env.METIS_QA_SCRATCH || DEFAULT_ROOT
}
