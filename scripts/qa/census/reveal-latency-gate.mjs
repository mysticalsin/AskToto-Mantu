#!/usr/bin/env node
/** node scripts/qa/census/reveal-latency-gate.mjs <report.json>: fails on FAIL or a missing report, warns on BLOCKED_EXTERNAL. */
import { existsSync, readFileSync } from 'node:fs'
import { revealLatencyGate } from './reveal-latency-lib.mjs'

const path = process.argv[2]
const report = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
const gate = revealLatencyGate(report)
if (gate.warning) console.log(`::warning title=Reveal latency blocked::${gate.message}`)
else console.log(gate.message)
process.exitCode = gate.fail ? 1 : 0
