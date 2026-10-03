import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { windowConstructionGate } from './st-1-core.mjs'

/** Every report one folder below `dir` (`<dir>/<run>/<run>.json`), each named by its path relative to `dir`. */
export function readWindowReports(dir) {
  const reports = []
  for (const run of readdirSync(dir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue
    for (const file of readdirSync(join(dir, run.name))) {
      if (!file.endsWith('.json')) continue
      try {
        reports.push({ name: join(run.name, file), report: JSON.parse(readFileSync(join(dir, run.name, file), 'utf8')) })
      } catch {
        /* not a report */
      }
    }
  }
  return reports
}

/** The window-construction gate over a report directory: 0 when it passes, 1 when it fails. */
export function gateWindow(dir, out) {
  const gate = { harness: 'ST-1', gate: 'window-construction', ...windowConstructionGate(existsSync(dir) ? readWindowReports(dir) : []) }
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(gate, null, 2)}\n`)
  }
  console.log(JSON.stringify(gate, null, 2))
  console.error(`[st-1] window gate skipped ${gate.skippedWarmups} warm-up launch${gate.skippedWarmups === 1 ? '' : 'es'}`)
  for (const failure of gate.failures) console.error(`[st-1] window gate FAIL — ${failure}`)
  return gate.pass ? 0 : 1
}
