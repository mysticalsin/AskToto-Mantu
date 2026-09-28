import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const M2_0016_FILES = Object.freeze([
  'prd-lock.md',
  'THREAT-MODEL.md',
  'COVERAGE-MAP.md',
  'm2-0016-evidence.json'
])

export const M2_0016_POLICY_ANSWERS = Object.freeze({
  D4: {
    question: 'Which system is the 2.0 entitlement authority?',
    answer: '"Operator seat"',
    text: 'Recorded policy [S1]: the Operator seat is authoritative for 2.0; the legacy license server stays read-only for existing keys until an ADR-016 deprecation decision.'
  },
  D11: {
    question: 'What is the fresh-install default speech route?',
    answer: '"Cloudflare via Operator"',
    text: 'Recorded policy [S1]: Cloudflare-hosted speech through the Operator session broker, with no organization token on the device; local speech is optional and never a silent fallback.'
  },
  D12: {
    question: 'What is the gateway log policy, and what does the retention claim say?',
    answer: '"Metadata-only"',
    text: 'Recorded policy [S1]: metadata-only gateway logs, no payload logging or caching; the claim says only what M2-0149 verifies. This is the separate approval MASTER §16.6.2 asks for; the end-to-end transport verification is still owed (DERIVED [S4]).'
  }
})

function ticketsText(tickets) {
  return tickets.join(', ')
}

function policyLines() {
  return Object.entries(M2_0016_POLICY_ANSWERS).map(([id, policy]) => {
    return `- ${id}. ${policy.question} Answer: ${policy.answer}. ${policy.text}`
  })
}

export function coverageRowsFromTraceability(traceability) {
  const rows = Array.isArray(traceability?.rows)
    ? traceability.rows.filter((row) => row.family === 'COV' && row.section === 25)
    : []
  return rows.map((row) => [
    row.id,
    row.title,
    Array.isArray(row.tickets) ? row.tickets : [],
    row.status ?? 'UNKNOWN'
  ])
}

export function m2_0016CoverageMap(traceability) {
  const rows = coverageRowsFromTraceability(traceability)
  return [
    '# Section 25 Coverage Map',
    '',
    'Generated from traceability.json. This public-safe artifact carries ticket IDs, statuses and titles only.',
    '',
    '| ID | Commitment | Tickets | Status |',
    '|---|---|---|---|',
    ...rows.map(([id, title, tickets, status]) => `| ${id} | ${title} | ${ticketsText(tickets)} | ${status} |`),
    ''
  ].join('\n')
}

export function m2_0016PrdLock(traceability) {
  const coverageRows = coverageRowsFromTraceability(traceability)
  return [
    '# Metis 2.0 PRD Lock',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Ticket | M2-0016 |',
    '| Version | 1.0 |',
    '| Evidence level | DESIGNED |',
    '| Gates other tickets | No |',
    '| Coverage rows | ' + coverageRows.length + ' Section 25 rows |',
    '',
    '## Scope',
    '',
    'This lock covers the full TASK-002 PRD, threat model and Section 25 coverage map after the one-page policy approval. It records policy answers for entitlement authority, default speech routing, gateway logging, local options, release lanes and signing scope. It does not claim product verification.',
    '',
    '## Policy Answers Copied From M2-0189',
    '',
    ...policyLines(),
    '',
    '## Speech And Local Options',
    '',
    '- Fresh 2.0 profiles default to Cloudflare-hosted speech through the Operator session broker.',
    '- No organization speech token is stored on the device for the broker route.',
    '- Local speech is explicit and optional; it is never a silent fallback when the broker route is unavailable.',
    '- Until the broker route is privacy-ready, the route is unavailable with an explicit local-install choice.',
    '',
    '## Retention Claim',
    '',
    'The approved wording is metadata-only. The product must not say "zero retention", "no logs" or "Cloudflare stores no data". Published privacy copy may say only what the verified route proves, including: "Authorized usage metadata is retained for administration".',
    '',
    '## Release Lanes',
    '',
    '- Windows and macOS release states are independent: Windows can reach a signed Electron lane without waiting for Apple prerequisites.',
    '- The macOS Electron lane remains blocked on legitimate Apple distribution prerequisites until those inputs exist.',
    '- Native Mac public distribution and Apple public signing are out of scope for this lock; they stay on their own lane and never block Windows-only signing.',
    '- Public release evidence must name exact candidate artifacts and platform state; unsigned QA artifacts count as zero customer-release evidence.',
    ''
  ].join('\n')
}

export function m2_0016ThreatModel() {
  return [
    '# Metis 2.0 Threat Model',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Ticket | M2-0016 |',
    '| Evidence level | DESIGNED |',
    '',
    '## Trust Boundaries',
    '',
    '| ID | Boundary | Rule |',
    '|---|---|---|',
    '| TB1 | Renderer to main IPC | Renderer input is untrusted; main owns policy, filesystem, network and process authority. |',
    '| TB2 | Main to Operator broker | Broker credentials are session-scoped and server-issued; no organization speech token lives on the device. |',
    '| TB3 | Local model and ASR sidecars | Sidecars are child capabilities owned by the app lifecycle; model output is data, not authority. |',
    '| TB4 | Cloud provider routes | Routes fail closed until transport, logging, cache and retention claims are verified. |',
    '| TB5 | Release artifacts | Unsigned or QA artifacts are not customer-release evidence. |',
    '| TB6 | Development and test execution to user data | Repository tests, scripts and app launches must not run on the owner Mac against live profiles or cloud-file folders; CI-only execution preserves the user-data boundary. |',
    '',
    '## Sidecar Ownership',
    '',
    '- The Electron main process owns local LLM, ASR, ffmpeg and helper sidecars.',
    '- Exit, relaunch, fatal-error and packaged-smoke paths must route through one ordered sidecar shutdown boundary.',
    '- A sidecar surviving the owning main process is a failed ownership boundary, not a successful background service.',
    '- Windows ownership evidence and macOS ownership evidence are separate release-lane facts; unsupported hosted-runner rows are BLOCKED_EXTERNAL with the exact unblock step.',
    '',
    '## Added M2-0016 Risk',
    '',
    '| ID | Threat | Control | Evidence status |',
    '|---|---|---|---|',
    '| TB6-R1 | A local dev/test command reads or mutates real user data. | Run repository tests and app execution only in GitHub Actions; local verification is limited to allowed TypeScript compile checks. | DESIGNED |',
    '| TB6-R2 | Sidecars outlive the desktop app and consume resources or stale credentials. | Main-owned registry, ordered shutdown and platform-specific survivor proof. | DESIGNED |',
    ''
  ].join('\n')
}

export function m2_0016Evidence(traceability) {
  const coverageRows = coverageRowsFromTraceability(traceability)
  return {
    schema: 1,
    ticket: 'M2-0016',
    evidence_level: 'DESIGNED',
    gates_other_tickets: false,
    generated_from: 'traceability.json',
    policy_answers: M2_0016_POLICY_ANSWERS,
    coverage: {
      section: 25,
      rows: coverageRows.length,
      all_rows_have_ticket: coverageRows.every(([, , tickets]) => Array.isArray(tickets) && tickets.length > 0)
    },
    threat_model_additions: ['TB6', 'sidecar ownership boundaries'],
    files: M2_0016_FILES
  }
}

function artifactText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(artifactText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(artifactText).join('\n')
  return String(value ?? '')
}

export function m2_0016Problems(artifacts) {
  const problems = []
  const serialized = artifactText(artifacts)
  const required = [
    'Version | 1.0',
    'Cloudflare-hosted speech through the Operator session broker',
    'local speech is optional and never a silent fallback',
    'Authorized usage metadata is retained for administration',
    'Apple public signing are out of scope',
    'TB6',
    'Development and test execution to user data',
    'Sidecar Ownership',
    'COV-44'
  ]
  for (const token of required) {
    if (!serialized.includes(token)) problems.push(`M2-0016 artifact missing required text: ${token}`)
  }
  for (const policy of Object.values(M2_0016_POLICY_ANSWERS)) {
    if (!serialized.includes(policy.answer) || !serialized.includes(policy.text)) {
      problems.push(`M2-0016 artifact missing policy answer: ${policy.answer}`)
    }
  }
  if (artifacts?.evidence?.coverage?.rows === 0) {
    problems.push('M2-0016 artifact missing Section 25 COV rows from traceability.json')
  }
  if (artifacts?.evidence?.coverage?.rows > 0 && artifacts?.evidence?.coverage?.all_rows_have_ticket === false) {
    problems.push('M2-0016 artifact has Section 25 COV rows without ticket coverage')
  }
  if (/\/Users\/|[A-Za-z]:\\Users\\|[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/.test(serialized)) {
    problems.push('M2-0016 artifact contains a user path or email address')
  }
  return problems
}

export function buildM2_0016Artifacts(traceability) {
  const artifacts = {
    prdLock: m2_0016PrdLock(traceability),
    threatModel: m2_0016ThreatModel(),
    coverageMap: m2_0016CoverageMap(traceability),
    evidence: m2_0016Evidence(traceability)
  }
  artifacts.problems = m2_0016Problems(artifacts)
  return artifacts
}

export function writeM2_0016Artifacts(root, outDir, traceability) {
  const artifacts = buildM2_0016Artifacts(traceability)
  writeFileSync(join(root, outDir, 'prd-lock.md'), artifacts.prdLock + '\n')
  writeFileSync(join(root, outDir, 'THREAT-MODEL.md'), artifacts.threatModel + '\n')
  writeFileSync(join(root, outDir, 'COVERAGE-MAP.md'), artifacts.coverageMap + '\n')
  writeFileSync(join(root, outDir, 'm2-0016-evidence.json'), JSON.stringify(artifacts.evidence, null, 2) + '\n')
  return artifacts
}
