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

export const M2_0016_COVERAGE_ROWS = Object.freeze([
  ['COV-01', 'One complete Codex handoff; plan, implement, verify and release', ['M2-0173', 'M2-0183'], 'NOT_STARTED'],
  ['COV-02', 'Deep audit of the entire shipped repository and existing systems', ['M2-0018'], 'NOT_STARTED'],
  ['COV-03', 'Minimal release-branch repair of both P1 blockers', ['M2-0042', 'M2-0046'], 'NOT_STARTED'],
  ['COV-04', 'Working signed Windows EXE on GitHub', ['M2-0058', 'M2-0174'], 'NOT_STARTED'],
  ['COV-05', 'Real native Mac product built using Codex', ['M2-0118'], 'NOT_STARTED'],
  ['COV-06', 'Mac public DMG waits only for legitimate Apple release prerequisites', ['M2-0175', 'M2-0186'], 'NOT_STARTED'],
  ['COV-07', 'Apple intelligence/PCC where truly eligible, with honest portal tracking', ['M2-0175'], 'NOT_STARTED'],
  ['COV-08', 'Hey Metis activation with no ambient cloud listening', ['M2-0081'], 'NOT_STARTED'],
  ['COV-09', 'Orb-only ARMED; solving orb inside active beam bar; caption above', ['M2-0093'], 'NOT_STARTED'],
  ['COV-10', 'Instant-feeling but safe commands on both platforms', ['M2-0170'], 'NOT_STARTED'],
  ['COV-11', 'Open/focus/gracefully close apps, windows and browser tabs', ['M2-0084', 'M2-0085'], 'NOT_STARTED'],
  ['COV-12', 'Complete Notes/hello/Arc/Norbert Wiener/X/camera reference workflow', ['M2-0170'], 'NOT_STARTED'],
  ['COV-13', 'Reliable stop, cancellation, replay and security boundaries', ['M2-0091'], 'NOT_STARTED'],
  ['COV-14', 'Repair right-edge typing and expanded-panel usability', ['M2-0095'], 'NOT_STARTED'],
  ['COV-15', 'Apple-minded four-destination Settings, with every old option dispositioned', ['M2-0101'], 'DONE'],
  ['COV-16', 'Cloudflare-hosted speech is the actual default everywhere', ['M2-0107', 'M2-0112'], 'NOT_STARTED'],
  ['COV-17', 'The strongest qualified transcript fidelity, not fluent invention', ['M2-0113'], 'NOT_STARTED'],
  ['COV-18', 'No Cloudflare content persistence; no-training is a separate statement', ['M2-0111', 'M2-0149'], 'NOT_STARTED'],
  ['COV-19', 'Independent optional local speech/generation fitted to actual hardware', ['M2-0116'], 'NOT_STARTED'],
  ['COV-20', 'No covert fallback, background bulk downloads or local-only cloud leaks', ['M2-0116'], 'NOT_STARTED'],
  ['COV-21', 'A truly lightweight application, not only a small bootstrap', ['M2-0164'], 'NOT_STARTED'],
  ['COV-22', 'Cloudflare delivery of selected components during honest onboarding', ['M2-0163'], 'NOT_STARTED'],
  ['COV-23', 'One portal Jev key for eligible devices; real Jev in action', ['M2-0123'], 'NOT_STARTED'],
  ['COV-24', 'Laya as a real alternative with no Jev API dependency', ['M2-0124'], 'NOT_STARTED'],
  ['COV-25', 'Jev/Laya in Mantu Intelligence, not only command demos', ['M2-0131'], 'NOT_STARTED'],
  ['COV-26', 'A trusted knowledge space/wiki/graph with evidence and corrections', ['M2-0125'], 'NOT_STARTED'],
  ['COV-27', 'Always-on knowledge when the laptop is asleep', ['M2-0119'], 'NOT_STARTED'],
  ['COV-28', 'Dust agents read authorized meeting context', ['M2-0128'], 'NOT_STARTED'],
  ['COV-29', 'Dust agents really write safely to canonical knowledge', ['M2-0129'], 'NOT_STARTED'],
  ['COV-30', 'Correction, deletion, revocation and confidential sources across systems', ['M2-0132'], 'NOT_STARTED'],
  ['COV-31', 'Central platform skills added and updated without reinstall', ['M2-0140'], 'NOT_STARTED'],
  ['COV-32', 'Skills execute on services with rich permitted knowledge', ['M2-0141'], 'NOT_STARTED'],
  ['COV-33', 'Portal tracks real people, devices, active sessions and skill runs', ['M2-0106'], 'NOT_STARTED'],
  ['COV-34', 'Accurate token, speech, decision and cost consumption', ['M2-0106'], 'NOT_STARTED'],
  ['COV-35', 'Keep standalone Metis and add useful Teams surfaces', ['M2-0152'], 'NOT_STARTED'],
  ['COV-36', 'Entra authentication and scoped service/agent permissions', ['M2-0121'], 'NOT_STARTED'],
  ['COV-37', 'Automatically join eligible meetings when they actually start', ['M2-0151', 'M2-0153', 'M2-0154'], 'NOT_STARTED'],
  ['COV-38', 'Real Teams media plus honest other-platform support', ['M2-0151', 'M2-0155', 'M2-0156'], 'NOT_STARTED'],
  ['COV-39', 'GDPR/privacy readiness and proper sharing-not a Teams badge', ['M2-0150'], 'NOT_STARTED'],
  ['COV-40', 'Whole meeting to knowledge to Dust update to skill to portal journey', ['M2-0176'], 'NOT_STARTED'],
  ['COV-41', 'Refactor the existing product with the actual supplied skill', ['M2-0059'], 'NOT_STARTED'],
  ['COV-42', 'Find code quickly with a persistent map and lean coding context', ['M2-0011'], 'IN_PROGRESS'],
  ['COV-43', 'Review every supplied repository/reference, including GitHub UI improvements', ['M2-0015'], 'NOT_STARTED'],
  ['COV-44', 'End-to-end deployed quality, recovery and durable handoff', ['M2-0183'], 'NOT_STARTED']
])

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
    ? traceability.rows.filter((row) => row.family === 'COV')
    : []
  if (rows.length > 0) {
    return rows.map((row) => [
      row.id,
      row.title,
      Array.isArray(row.tickets) ? row.tickets : [],
      row.status ?? 'UNKNOWN'
    ])
  }
  return M2_0016_COVERAGE_ROWS.map((row) => [...row])
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

export function m2_0016Problems(artifacts) {
  const problems = []
  const serialized = JSON.stringify(artifacts)
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
