#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runWithTempPeak } from './footprint-lib.mjs'

const USAGE = `Usage:
  node scripts/qa/census/measure-install.mjs --temp-dir <dir> [--output <json>] -- <command> [args...]

Runs the install command with TEMP/TMP/TMPDIR set to <dir> and records the peak bytes seen there while it ran.
Output defaults to metis-census-output/temp-peak.json. Exits with the command's exit code.
`

async function main() {
  const argv = process.argv.slice(2)
  const split = argv.indexOf('--')
  const flags = split === -1 ? argv : argv.slice(0, split)
  const command = split === -1 ? [] : argv.slice(split + 1)
  let tempDir
  let output = 'metis-census-output/temp-peak.json'
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--help' || flags[i] === '-h') {
      console.log(USAGE)
      return
    }
    if (flags[i] === '--temp-dir') tempDir = flags[(i += 1)]
    else if (flags[i] === '--output') output = flags[(i += 1)]
    else throw new Error(`unknown argument: ${flags[i]}`)
  }
  if (!tempDir || command.length === 0) throw new Error(`--temp-dir and a command after -- are required\n${USAGE}`)
  const result = await runWithTempPeak({ command: command[0], args: command.slice(1), tempDir })
  const out = resolve(output)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`[measure-install] peak ${result.peakBytes} bytes over ${result.samples} samples; wrote ${out}`)
  process.exitCode = result.exitCode
}

main().catch((error) => {
  console.error(`[measure-install] ${error?.message ?? error}`)
  process.exitCode = 1
})
