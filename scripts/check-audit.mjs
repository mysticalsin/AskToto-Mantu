#!/usr/bin/env node
/**
 * check-audit.mjs — the SCA gate: fail on any HIGH/CRITICAL advisory, except findings that live
 * entirely inside @dust-tt/client's bundled server tree.
 *
 * Why the carve-out is safe, and why a bare `npm audit --audit-level=high` cannot be the gate:
 * npm audit reads package-lock.json's DECLARED tree. @dust-tt/client bundles an MCP server whose
 * metadata drags in old express-rate-limit / ip-address versions — but postinstall
 * (scripts/prune-dust-bundle.mjs) deletes that unused server tree from disk, and
 * check-packaged-runtime verifies the finished app.asar never contains it. The advisory is therefore
 * about code that provably does not ship, yet npm audit cannot see the pruned disk state, so blocking
 * on it would leave CI permanently red on a false positive — which trains everyone to ignore the gate.
 *
 * The carve-out is NARROW on purpose: only findings whose every node path sits under
 * node_modules/@dust-tt/client/ are excused. A real high anywhere else — including a new one inside
 * dust's tree that ALSO affects a path outside it — fails the build. Drop the carve-out when
 * @dust-tt/client publishes a release without the stale bundled metadata.
 *
 * INDEPENDENTLY CONFIRMED (2026-08-24). An authenticated `snyk test --all-projects
 * --strict-out-of-sync=false --severity-threshold=high` across all six scannable manifests reported
 * exactly ONE high finding, and it is this same carve-out:
 *
 *     express-rate-limit@8.2.1 — Allocation of Resources Without Limits or Throttling
 *     via @dust-tt/client@1.2.6 > @modelcontextprotocol/sdk@1.26.0 > express-rate-limit@8.2.1
 *
 * Verified against the BUILT artefact rather than the lockfile: that nested path has zero entries in the
 * shipped app.asar, and the copies that do ship are the root ones — express-rate-limit@8.6.2 and
 * @modelcontextprotocol/sdk@1.29.0, both above every version the advisory names as fixed. Every other
 * manifest (intelligence, license-server ×2) came back clean.
 *
 * Two gaps that scan could not cover, so nobody should read it as total: native-app/MetisKit/Package.swift
 * needs a Swift toolchain (macOS), and Snyk Code (SAST) is not enabled for this organization — the
 * dependency scan says nothing about our own source.
 *
 * SAST (Snyk Code), 2026-08-24. Enabled on the org and run: 6 HIGH findings, all triaged to false
 * positives, each verified rather than waved away. Recorded so nobody re-triages them from scratch:
 *
 *   - Path Traversal, license-server/lib/app.mjs:555 — req.params.name reaching res.download. Guarded by
 *     BACKUP_FILE_RE (/^licenses-backup-[0-9TZ-]+\.json$/, anchored, digits/T/Z/hyphen only) AND
 *     path.basename(name) === name, behind requireAdmin. Tested against 8 payloads including encoded,
 *     null-byte and Windows-separator variants: every one blocked. Snyk's taint analysis does not model
 *     the regex+basename guard.
 *   - Hardcoded secret ×3, src/shared/ipc.ts:42-44 — 'settings:setApiKey' and siblings are IPC CHANNEL
 *     NAMES. The literal contains "ApiKey"; it is not a key.
 *   - Hardcoded secret, src/main/llm/local.ts:206 — apiKey: 'fm-loopback' is a placeholder the OpenAI SDK
 *     requires as a non-empty string. `fm serve` binds 127.0.0.1 and has no auth surface.
 *   - Hardcoded secret, license-server/admin/index.html:974 — a localStorage KEY name, not a token.
 *
 * Worth its own look, and NOT what Snyk flagged: that admin page keeps its session token in
 * localStorage, which is XSS-exfiltratable by design. Out of scope for this file; noted so it is not
 * mistaken for something the SAST run cleared.
 *
 * Usage: node scripts/check-audit.mjs   (exit 0 = clean or excused-only; 1 = real findings)
 */
import { execSync } from 'node:child_process'

const EXCUSED_PREFIX = 'node_modules/@dust-tt/client/'

let raw
try {
  raw = execSync('npm audit --omit=dev --json', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
} catch (e) {
  // npm audit exits non-zero when vulnerabilities exist — the JSON is still on stdout.
  raw = e.stdout?.toString() ?? ''
}

let report
try {
  report = JSON.parse(raw)
} catch {
  console.error('[check:audit] could not parse `npm audit --json` output — failing closed')
  process.exit(1)
}

const bad = []
const excused = []
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if (v.severity !== 'high' && v.severity !== 'critical') continue
  const nodes = Array.isArray(v.nodes) ? v.nodes : []
  const fullyInsideDustBundle = nodes.length > 0 && nodes.every((n) => String(n).startsWith(EXCUSED_PREFIX))
  if (fullyInsideDustBundle) excused.push(`${name} (${v.severity})`)
  else bad.push(`${name} (${v.severity}) at ${nodes.join(', ') || '(no path reported)'}`)
}

if (excused.length) {
  console.log(
    `[check:audit] excused ${excused.length} advisory(ies) confined to the pruned @dust-tt bundle: ${excused.join('; ')}`
  )
}
if (bad.length) {
  console.error(`[check:audit] FAIL — ${bad.length} high/critical advisory(ies) in shipped dependency paths:`)
  for (const b of bad) console.error(`  - ${b}`)
  process.exit(1)
}
console.log('[check:audit] OK — no high/critical advisories outside the documented carve-out')
