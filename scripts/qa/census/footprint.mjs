#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  buildFootprintReport,
  collectInventory,
  directoryBytes,
  findDuplicates,
  parseTtfcBenchOutput,
  sha256File
} from './footprint-lib.mjs'

function usage() {
  return `Usage:
  node scripts/qa/census/footprint.mjs --artifact <dmg|exe> --install-root <dir> --temp-dir <dir> --release-tag <tag> [--output <json>]

Inputs:
  --artifact <path>      Downloaded release artifact (compressed size and sha256 are measured from it).
  --install-root <dir>   Installed app root (Metis.app directory on macOS, install directory on Windows).
  --temp-dir <dir>       Runner temp directory after install; its bytes outside the install root and the
                         downloaded artifact are the temporary install footprint.
  --release-tag <tag>    Release the artifact was downloaded from.
  --ttfc-output <path>   Saved stdout of scripts/bench-asr-ttfc.mjs (scheduling budget only, not live latency).
  --output <path>        JSON output. Defaults to metis-census-output/footprint.json.
`
}

const FLAGS = {
  '--artifact': 'artifact',
  '--install-root': 'installRoot',
  '--temp-dir': 'tempDir',
  '--release-tag': 'releaseTag',
  '--ttfc-output': 'ttfcOutput',
  '--output': 'output'
}

function readArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (FLAGS[arg]) {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      args[FLAGS[arg]] = argv[i]
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function main() {
  const args = readArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (key !== 'ttfcOutput' && key !== 'output' && !args[key]) throw new Error(`${flag} is required`)
  }
  const artifactPath = resolve(args.artifact)
  const installRoot = resolve(args.installRoot)
  const latency = args.ttfcOutput
    ? {
        ...parseTtfcBenchOutput(readFileSync(args.ttfcOutput, 'utf8')),
        source: 'scripts/bench-asr-ttfc.mjs (scheduling, decode stubbed)'
      }
    : { schedulingBudgetMs: null, stubDecodeMs: null, source: null }
  const report = buildFootprintReport({
    releaseTag: args.releaseTag,
    runId: process.env.GITHUB_RUN_ID ?? null,
    artifact: { name: basename(artifactPath), bytes: statSync(artifactPath).size, sha256: sha256File(artifactPath) },
    unpacked: directoryBytes(installRoot),
    temporary: {
      ...directoryBytes(args.tempDir, { exclude: [installRoot, artifactPath] }),
      scope: 'runner temp directory after install, excluding the install root and the downloaded artifact'
    },
    duplicates: findDuplicates(installRoot),
    latency: { ...latency, liveCaptureToCaptionMs: null },
    inventory: collectInventory({ installRoot })
  })
  const output = resolve(args.output ?? 'metis-census-output/footprint.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[footprint] wrote ${output}`)
}

try {
  main()
} catch (error) {
  console.error(`[footprint] ${error?.message ?? error}`)
  process.exitCode = 1
}
