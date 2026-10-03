import { readFileSync } from 'node:fs'

function readNumericExport(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*([^\\n]+)`).exec(source)
  if (!match) throw new Error(`${name} was not found in capture-backoff.ts`)
  const value = Function(`"use strict"; return (${match[1].replace(/;.*/, '')});`)()
  if (!Number.isFinite(value)) throw new Error(`${name} did not resolve to a finite number`)
  return value
}

export function readCaptureBackoffConstants(source) {
  return {
    BACKOFF_MAX_MS: readNumericExport(source, 'BACKOFF_MAX_MS'),
    BACKOFF_LATCH_AFTER: readNumericExport(source, 'BACKOFF_LATCH_AFTER')
  }
}

export const CAPTURE_BACKOFF_CONSTANTS = Object.freeze(
  readCaptureBackoffConstants(readFileSync(new URL('../../../src/main/capture-backoff.ts', import.meta.url), 'utf8'))
)
export const MAX_BG_FAILURES = CAPTURE_BACKOFF_CONSTANTS.BACKOFF_LATCH_AFTER + 1
