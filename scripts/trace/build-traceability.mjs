#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DEFAULT_OUT = 'out/m2-0018-targeted-review'

const reviewedScopes = [
  { path: 'src/main/brain/corrections.ts', expectedLines: 1629, axis: 'brain-corrections' },
  { path: 'src/main/brain/publish.ts', expectedLines: 990, axis: 'brain-publish' },
  { path: 'src/main/llm/prewarm.ts', expectedLines: 62, axis: 'local-model-prewarm' },
  { path: 'src/main/index.ts', axis: 'local-model-prewarm' },
  { path: 'src/main/infra/scheduler/maintenance.ts', axis: 'scheduler-policy' },
  { path: 'src/main/infra/scheduler/policy.ts', axis: 'scheduler-policy' },
  { path: 'scripts/qa/e2e-workflows.mjs', axis: 'proof-harnesses' },
  { path: 'scripts/e2e-smoke.mjs', axis: 'proof-harnesses' },
  { path: 'scripts/check-packaged-launch.mjs', axis: 'proof-harnesses' },
  { path: 'scripts/check-packaged-asr.mjs', axis: 'proof-harnesses' },
  { path: 'scripts/evals/local-recap.mjs', axis: 'proof-harnesses' },
  { path: 'scripts/evals/local-recap.run.ts', axis: 'proof-harnesses' },
  { path: 'build/entitlements.mac.plist', axis: 'packaging-inputs' },
  { path: 'build/entitlements.mas.plist', axis: 'packaging-inputs' },
  { path: 'build/entitlements.mas.inherit.plist', axis: 'packaging-inputs' },
  { path: 'build/managed-config.example.json', axis: 'packaging-inputs' },
  { path: 'build/managed-config.enterprise.example.json', axis: 'packaging-inputs' },
  { path: 'build/install-metis.command', axis: 'packaging-inputs' },
  { path: 'build/Install Metis.command', axis: 'packaging-inputs' },
  { path: 'scripts/install-metis-mac.sh', axis: 'packaging-inputs' },
  { path: 'src/shared/metis-command-session.ts', axis: 'command-wake' },
  { path: 'src/shared/metis-command-parse.ts', axis: 'command-wake' },
  { path: 'src/shared/metis-command-proposal.ts', axis: 'command-wake' },
  { path: 'src/shared/metis-wake.ts', axis: 'command-wake' },
  { path: 'src/shared/desktop-actions.ts', axis: 'command-wake' },
  { path: 'src/main/metis-command-register.ts', axis: 'command-wake' },
  { path: 'src/main/application-command-session.ts', axis: 'command-wake' },
  { path: 'src/renderer/src/components/CommandListeningPill.tsx', axis: 'command-wake' },
  { path: 'src/renderer/src/components/CommandProposalCard.tsx', axis: 'command-wake' },
  { path: 'src/renderer/src/lib/use-command-mic.ts', axis: 'command-wake' }
]

const ticketActions = [
  {
    public_ref: 'M2-0018-F01',
    axis: 'brain-corrections',
    verdict: 'no_new_ticket',
    ledger_action: {
      kind: 'acceptance_line',
      ticket: 'M2-0018',
      text: 'Record that corrections.ts was read in full and no additional public-ticketed defect was found beyond existing correction-journal safeguards.'
    },
    evidence: [
      'src/main/brain/corrections.ts:338 readCorrectionsJournalSafe gates write paths before mutation.',
      'src/main/brain/corrections.ts:925 renameEntity appends the correction before applyRename.',
      'src/main/brain/corrections.ts:1549 replayCorrections reuses apply functions under the entity lock.'
    ]
  },
  {
    public_ref: 'M2-0018-F02',
    axis: 'brain-publish',
    verdict: 'no_new_ticket',
    ledger_action: {
      kind: 'acceptance_line',
      ticket: 'M2-0018',
      text: 'Record that publish.ts was read in full and its current confidentiality gates, batch scans, and owned-wiki deletion constraints are covered by existing code.'
    },
    evidence: [
      'src/main/brain/publish.ts:238 readConfidentialMeetings fails closed on unreadable/confidential meetings.',
      'src/main/brain/publish.ts:541 publishEntity removes confidential-only entity pages.',
      'src/main/brain/publish.ts:947 publishAll batches confidential and alias scans once per regeneration.'
    ]
  },
  {
    public_ref: 'M2-0018-F03',
    axis: 'local-model-prewarm',
    verdict: 'acceptance_on_existing_ticket',
    ledger_action: {
      kind: 'acceptance_line',
      ticket: 'M2-0018',
      text: 'Record that boot-time local prewarm is confirmed as unattended model work and is already routed through runAsMaintenance.'
    },
    evidence: [
      'src/main/infra/scheduler/maintenance.ts:4 defines boot-time local warm as unattended model work.',
      'src/main/index.ts:9174 documents the boot warm as waiting for the maintenance gate.',
      'src/main/index.ts:9179 and src/main/index.ts:9182 call runAsMaintenance(warmLocalIfReady).'
    ]
  },
  {
    public_ref: 'M2-0018-F04',
    axis: 'proof-harnesses',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Add Windows packaged ASR decode gate to candidate validation',
      acceptance: [
        'The candidate lane runs the packaged ASR harness against the exact Windows candidate bytes.',
        'The report records PASS only when separate Whisper and Parakeet imports decode through bundled packaged resources with no engine fallback.',
        'Rows that require a physical QA machine, a real cloud-file provider, or an outside account are emitted as BLOCKED_EXTERNAL with the exact unblock step.'
      ]
    },
    evidence: [
      'scripts/check-packaged-asr.mjs:3 identifies packaged ASR decode as a Windows packaged-app gate.',
      'scripts/check-packaged-asr.mjs:167 drives real import IPC.',
      'scripts/check-packaged-asr.mjs:214 and scripts/check-packaged-asr.mjs:222 require separate Whisper and Parakeet jobs.'
    ]
  },
  {
    public_ref: 'M2-0018-F05',
    axis: 'proof-harnesses',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Bind packaged lifecycle smoke evidence to candidate artifacts',
      acceptance: [
        'For every promotable installer sha256 in candidate provenance, CI records a content-free packaged lifecycle PASS.',
        'The lifecycle PASS covers install, renderer-ready survival, reopen routes, product Quit, clean-shutdown audit, and zero owned-process survivors.',
        'The uploaded report names the exact candidate artifact sha256 it exercised.'
      ]
    },
    evidence: [
      'scripts/qa/packaged-smoke.mjs:7 describes install, ready, reopen, quit, and survivor checks.',
      'scripts/qa/packaged-smoke.mjs:579 requires clean shutdown evidence.',
      '.github/workflows/packaged-smoke.yml:10 states the smoke lane builds its own app on demand.'
    ]
  },
  {
    public_ref: 'M2-0018-F06',
    axis: 'proof-harnesses',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Cover packaged native audio picker wiring separately from ASR decode',
      acceptance: [
        'A Windows packaged gate proves the native audio file picker path returns a usable import capability token through the production IPC path.',
        'The gate does not substitute the dialog result inside Electron.',
        'The report is content-free and records BLOCKED_EXTERNAL if hosted runners cannot exercise the native dialog.'
      ]
    },
    evidence: [
      'scripts/check-packaged-asr.mjs:21 documents that the ASR gate does not cover native Open File dialog wiring.',
      'scripts/check-packaged-asr.mjs:63 injects the file path directly for decode coverage.'
    ]
  },
  {
    public_ref: 'M2-0018-F07',
    axis: 'proof-harnesses',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Add macOS packaged two-slice launch evidence',
      acceptance: [
        'The macOS packaged gate records renderer-ready survival for the native arm64 slice.',
        'The macOS packaged gate records renderer-ready survival for the x64 slice under Rosetta on an Apple Silicon runner, or records the exact external blocker.',
        'The report names the tested package sha256 and architecture mode without user data or meeting content.'
      ]
    },
    evidence: [
      'scripts/check-packaged-launch.mjs:20 documents macOS launch readiness limits.',
      'scripts/check-packaged-launch.mjs:120 keeps macOS readiness weaker than full workflow proof.'
    ]
  },
  {
    public_ref: 'M2-0018-F08',
    axis: 'proof-harnesses',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Run packaged visual onboarding smoke after install',
      acceptance: [
        'A packaged CI job runs the visual onboarding and right-edge smoke against an installed app.',
        'The job uploads non-empty screenshots and fails on stale artifacts, renderer errors, or non-persisted layout settings.',
        'Rows unsupported on hosted runners are reported as BLOCKED_EXTERNAL with the exact unblock step.'
      ]
    },
    evidence: [
      'scripts/e2e-smoke.mjs:39 supports packaged executable input.',
      'scripts/e2e-smoke.mjs:1053 exercises the right-edge/onboarding visual path.',
      'scripts/e2e-smoke.mjs:1108 records screenshot evidence.'
    ]
  },
  {
    public_ref: 'M2-0018-F09',
    axis: 'packaging-inputs',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Add a lightweight online installer profile',
      acceptance: [
        'macOS and Windows lightweight artifacts exclude bundled large model, ASR, LLM, and related runtime payloads.',
        'First-use downloads stay size- and SHA-pinned to reviewed manifests.',
        'The full offline installer remains a separate target, and CI fails lightweight artifacts that exceed the agreed byte budget.'
      ]
    },
    evidence: [
      'electron-builder.yml:88 and electron-builder.yml:100 copy large runtime assets into packaged resources.',
      'scripts/check-release.mjs:17 caps release artifacts near a platform limit, not a lightweight-install budget.',
      'docs/ENTERPRISE-DEPLOY-WINDOWS.md:17 describes an offline/self-contained deployment posture.'
    ]
  },
  {
    public_ref: 'M2-0018-F10',
    axis: 'packaging-inputs',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Remove quarantine-clearing scripts from public install paths',
      acceptance: [
        'Release and promotion upload manifests cannot include install scripts that clear macOS quarantine.',
        'Public macOS install docs describe only notarized Developer ID install paths.',
        'Any QA-only helper is clearly non-customer and gated from release assets.'
      ]
    },
    evidence: [
      'docs/INSTALL.md:26 tells users not to remove quarantine manually.',
      'scripts/install-metis-mac.sh:83 clears quarantine.',
      'build/install-metis.command:55 clears quarantine.'
    ]
  },
  {
    public_ref: 'M2-0018-F11',
    axis: 'packaging-inputs',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Make Windows Portable QA-only or explicitly non-managed',
      acceptance: [
        'Either Metis-Portable artifacts are no longer promotable in customer releases, or they publish only under a clearly non-updating QA/manual channel.',
        'Docs and candidate provenance match the selected status.',
        'Managed lightweight deployment guidance points to updating installer channels only.'
      ]
    },
    evidence: [
      'electron-builder.yml:278 defines the Windows portable target.',
      'docs/INSTALL.md:18 lists Windows portable as an install option.',
      'scripts/qa/provenance.mjs:34 includes portable artifacts in provenance collection.'
    ]
  },
  {
    public_ref: 'M2-0018-F12',
    axis: 'packaging-inputs',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Align managed-config docs with implemented enterprise controls',
      acceptance: [
        'Public docs and example JSON list only enforced enterprise keys.',
        'License-gate wording is removed until enforcement is compiled on and verified end to end.',
        'The managed-config example remains public-safe and contains no tenant-specific identifiers.'
      ]
    },
    evidence: [
      'build/managed-config.enterprise.example.json:21 omits the license-gate key because enforcement is not active there.',
      'docs/SIGNING.md:133 still lists License gate as enabled/locked.'
    ]
  },
  {
    public_ref: 'M2-0018-F13',
    axis: 'command-wake',
    verdict: 'acceptance_on_existing_ticket',
    ledger_action: {
      kind: 'acceptance_line',
      ticket: 'M2-0013',
      text: 'Record command/wake review result: flushPending / mark_committed logic was not found in command-mic code; command-mic remains renderer-only and does not own command ingest.'
    },
    evidence: [
      'src/renderer/src/lib/use-command-mic.ts:60 owns renderer microphone lease state only.',
      'src/renderer/src/lib/use-command-mic.ts:203 finalizes renderer hook state without main command ingestion.',
      'src/shared/metis-command-session.ts:96 ignores meeting transcripts as authority.'
    ]
  },
  {
    public_ref: 'M2-0018-F14',
    axis: 'command-wake',
    verdict: 'acceptance_on_existing_ticket',
    ledger_action: {
      kind: 'acceptance_line',
      ticket: 'M2-0079',
      text: 'Record unwired command-mic review result: the command hotkey opens right-edge UI only, CommandProposalCard is not production-wired, and opaque right-edge proposals remain cancel-only.'
    },
    evidence: [
      'src/renderer/src/App.tsx:3063 opens the right-edge UI from the command hotkey.',
      'src/renderer/src/components/RightEdgeSidecar.tsx:208 explicitly avoids useCommandMic.',
      'src/renderer/src/components/RightEdgeSidecar.tsx:397 renders pending opaque command state as cancel-only.'
    ]
  },
  {
    public_ref: 'M2-0018-F15',
    axis: 'command-wake',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Wire explicit command mic to main-owned command capture',
      acceptance: [
        'Pressing the command hotkey starts a bounded, main-owned command capture session.',
        'Recognized command text streams only to the command runtime and never uses meeting transcripts as authority.',
        'Command capture releases microphone and capture ownership on timeout, cancel, window replacement, and meeting capture reservation.'
      ]
    },
    evidence: [
      'src/main/metis-command-runtime.ts:17 reserves execution authority outside the parser runtime.',
      'src/main/command-control.ts:85 consumes nonce-bound confirmation before adapter execution.',
      'src/shared/metis-command-session.ts:121 creates descriptive proposals from command text.'
    ]
  },
  {
    public_ref: 'M2-0018-F16',
    axis: 'command-wake',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Render verified command listening and proposal UX',
      acceptance: [
        'Command capture shows the listening pill during active capture.',
        'The UI switches to a verified allowlisted proposal preview when main supplies one.',
        'The UI never renders a confirm control for opaque proposal state.'
      ]
    },
    evidence: [
      'src/renderer/src/components/CommandListeningPill.tsx exists as the listening indicator.',
      'src/renderer/src/components/CommandProposalCard.tsx exists as the proposal surface.',
      'src/shared/ipc.ts:1872 exposes opaque command state to the renderer.'
    ]
  },
  {
    public_ref: 'M2-0018-F17',
    axis: 'command-wake',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Unify command session authority boundary',
      acceptance: [
        'The app has one documented command path from hotkey or wake through parse, proposal, cancel or confirm, execution, and revocation.',
        'Stale proposals are revoked on replacement, expiry, stop, owner loss, and meeting capture reservation.',
        'Legacy desktop-action parsing and application-command sessions are integrated or explicitly separated by policy.'
      ]
    },
    evidence: [
      'src/shared/metis-command-parse.ts defines legacy desktop-action parsing.',
      'src/main/application-command-session.ts owns application command sessions.',
      'src/shared/desktop-actions.ts marks desktop.photo_booth_capture as unable to reach decide.'
    ]
  },
  {
    public_ref: 'M2-0018-F18',
    axis: 'command-wake',
    verdict: 'new_ticket',
    ledger_action: {
      kind: 'new_ticket',
      title: 'Add CI coverage for end-to-end command mic flow',
      acceptance: [
        'CI covers hotkey summon, command capture start and stop, transcript-ingestion source separation, proposal preview visibility, cancel-only opaque state, one-use confirmation, and command-mic teardown.',
        'Coverage runs only in CI and does not require repository tests on developer Macs.',
        'The uploaded evidence contains no transcript or meeting content.'
      ]
    },
    evidence: [
      'src/renderer/src/components/CommandListeningPill.contract.test.ts exists for the indicator contract.',
      'src/renderer/src/lib/use-command-mic.test.ts exists for hook behavior.',
      'src/renderer/src/components/RightEdgeSidecar.command-mic-guard.test.tsx exists for right-edge guard behavior.'
    ]
  }
]

const REQUIRED_SCOPE_AXES = [
  'brain-corrections',
  'brain-publish',
  'local-model-prewarm',
  'scheduler-policy',
  'proof-harnesses',
  'packaging-inputs',
  'command-wake'
]

const REQUIRED_FINDING_AXES = [
  'brain-corrections',
  'brain-publish',
  'local-model-prewarm',
  'proof-harnesses',
  'packaging-inputs',
  'command-wake'
]

const REQUIRED_FINDING_MAPPINGS = [
  ['M2-0018-F01', 'brain-corrections', 'acceptance_line', 'M2-0018'],
  ['M2-0018-F02', 'brain-publish', 'acceptance_line', 'M2-0018'],
  ['M2-0018-F03', 'local-model-prewarm', 'acceptance_line', 'M2-0018'],
  ['M2-0018-F04', 'proof-harnesses', 'new_ticket', 'Add Windows packaged ASR decode gate to candidate validation'],
  ['M2-0018-F05', 'proof-harnesses', 'new_ticket', 'Bind packaged lifecycle smoke evidence to candidate artifacts'],
  ['M2-0018-F06', 'proof-harnesses', 'new_ticket', 'Cover packaged native audio picker wiring separately from ASR decode'],
  ['M2-0018-F07', 'proof-harnesses', 'new_ticket', 'Add macOS packaged two-slice launch evidence'],
  ['M2-0018-F08', 'proof-harnesses', 'new_ticket', 'Run packaged visual onboarding smoke after install'],
  ['M2-0018-F09', 'packaging-inputs', 'new_ticket', 'Add a lightweight online installer profile'],
  ['M2-0018-F10', 'packaging-inputs', 'new_ticket', 'Remove quarantine-clearing scripts from public install paths'],
  ['M2-0018-F11', 'packaging-inputs', 'new_ticket', 'Make Windows Portable QA-only or explicitly non-managed'],
  ['M2-0018-F12', 'packaging-inputs', 'new_ticket', 'Align managed-config docs with implemented enterprise controls'],
  ['M2-0018-F13', 'command-wake', 'acceptance_line', 'M2-0013'],
  ['M2-0018-F14', 'command-wake', 'acceptance_line', 'M2-0079'],
  ['M2-0018-F15', 'command-wake', 'new_ticket', 'Wire explicit command mic to main-owned command capture'],
  ['M2-0018-F16', 'command-wake', 'new_ticket', 'Render verified command listening and proposal UX'],
  ['M2-0018-F17', 'command-wake', 'new_ticket', 'Unify command session authority boundary'],
  ['M2-0018-F18', 'command-wake', 'new_ticket', 'Add CI coverage for end-to-end command mic flow']
]

function rel(path) {
  return path.split('\\').join('/')
}

function readRel(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function scopeRecord(scope) {
  const abs = join(ROOT, scope.path)
  if (!existsSync(abs)) return { ...scope, exists: false }
  const text = readFileSync(abs, 'utf8')
  const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0)
  return { ...scope, exists: true, lines, sha256: sha256(text) }
}

function leadAction(finding) {
  if (finding.ledger_action?.kind === 'new_ticket') {
    return `LEAD_ACTION: Lead creates new ledger ticket from ${finding.public_ref}: ${finding.ledger_action.title ?? 'missing title'}.`
  }
  if (finding.ledger_action?.kind === 'acceptance_line') {
    return `LEAD_ACTION: Lead adds acceptance evidence from ${finding.public_ref} to ${finding.ledger_action.ticket ?? 'missing ticket'}.`
  }
  return `LEAD_ACTION: Lead reviews malformed ledger action for ${finding.public_ref}.`
}

function findingReportRecord(finding) {
  return {
    ...finding,
    lead_action: leadAction(finding)
  }
}

function checkReport(report) {
  const problems = []
  const scopeAxes = new Set(report.reviewed_scopes.map((scope) => scope.axis))
  for (const axis of REQUIRED_SCOPE_AXES) {
    if (!scopeAxes.has(axis)) problems.push(`scope axis ${axis}: missing reviewed scope`)
  }
  for (const scope of report.reviewed_scopes) {
    if (!scope.exists) problems.push(`${scope.path}: missing scoped file`)
    if (scope.expectedLines !== undefined && scope.lines !== scope.expectedLines) {
      problems.push(`${scope.path}: expected ${scope.expectedLines} lines, found ${scope.lines}`)
    }
  }
  const findingAxes = new Set(report.findings.map((finding) => finding.axis))
  for (const axis of REQUIRED_FINDING_AXES) {
    if (!findingAxes.has(axis)) problems.push(`finding axis ${axis}: missing mapped finding`)
  }
  const refs = new Set()
  const findingsByRef = new Map()
  for (const finding of report.findings) {
    if (refs.has(finding.public_ref)) problems.push(`${finding.public_ref}: duplicate public_ref`)
    refs.add(finding.public_ref)
    findingsByRef.set(finding.public_ref, finding)
    if (!finding.ledger_action) problems.push(`${finding.public_ref}: missing ledger_action`)
    if (finding.ledger_action?.kind === 'new_ticket' && !Array.isArray(finding.ledger_action.acceptance)) {
      problems.push(`${finding.public_ref}: new_ticket requires acceptance lines`)
    }
    if (finding.ledger_action?.kind === 'new_ticket' && Array.isArray(finding.ledger_action.acceptance) && finding.ledger_action.acceptance.length === 0) {
      problems.push(`${finding.public_ref}: new_ticket acceptance lines cannot be empty`)
    }
    if (finding.ledger_action?.kind === 'acceptance_line' && !/^M2-\d{4}$/.test(finding.ledger_action.ticket ?? '')) {
      problems.push(`${finding.public_ref}: acceptance_line requires an M2 ticket`)
    }
    if (typeof finding.lead_action !== 'string' || !finding.lead_action.startsWith('LEAD_ACTION: ')) {
      problems.push(`${finding.public_ref}: missing LEAD_ACTION lead handoff`)
    }
  }
  for (const [publicRef, axis, kind, target] of REQUIRED_FINDING_MAPPINGS) {
    const finding = findingsByRef.get(publicRef)
    if (!finding) {
      problems.push(`${publicRef}: missing required finding mapping`)
      continue
    }
    if (finding.axis !== axis) problems.push(`${publicRef}: expected axis ${axis}, found ${finding.axis}`)
    if (finding.ledger_action?.kind !== kind) {
      problems.push(`${publicRef}: expected ledger_action kind ${kind}, found ${finding.ledger_action?.kind ?? 'missing'}`)
      continue
    }
    const actualTarget = kind === 'new_ticket' ? finding.ledger_action.title : finding.ledger_action.ticket
    if (actualTarget !== target) problems.push(`${publicRef}: expected target ${target}, found ${actualTarget}`)
  }
  for (const publicRef of refs) {
    if (!REQUIRED_FINDING_MAPPINGS.some(([expectedRef]) => expectedRef === publicRef)) {
      problems.push(`${publicRef}: unexpected finding mapping`)
    }
  }
  const serialized = JSON.stringify(report)
  if (/\/Users\/|[A-Za-z]:\\Users\\|[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/.test(serialized)) {
    problems.push('report contains a user path or email address')
  }
  return problems
}

function markdown(report) {
  const findingLines = report.findings.map((finding) => {
    const action = finding.ledger_action.kind === 'new_ticket'
      ? `lead must create a new ticket: ${finding.ledger_action.title}`
      : `lead must add an acceptance line to ${finding.ledger_action.ticket}`
    return `- ${finding.public_ref} (${finding.axis}): ${finding.verdict}; ${action}; ${finding.lead_action}`
  })
  return [
    '# M2-0018 Targeted Review Traceability',
    '',
    'Public-safe artifact. It contains no private review identifiers, private program paths, secrets, account IDs, personal emails, or meeting content.',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Scope',
    '',
    ...report.reviewed_scopes.map((scope) => `- ${scope.path}: ${scope.exists ? `${scope.lines} lines` : 'missing'}`),
    '',
    '## Findings And Ledger Actions',
    '',
    ...findingLines,
    '',
    '## Verification',
    '',
    `- ${report.check.problems.length === 0 ? 'PASS' : 'FAIL'}: required scope axes, finding mappings, lead actions, and private-reference hygiene passed.`
  ].join('\n')
}

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: DEFAULT_OUT },
    check: { type: 'boolean', default: false }
  }
})

const outDir = rel(values.out || DEFAULT_OUT)
const report = {
  schema: 1,
  ticket: 'M2-0018',
  evidence_level: 'DESIGNED',
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  reviewed_scopes: reviewedScopes.map(scopeRecord),
  findings: ticketActions.map(findingReportRecord),
  check: { problems: [] }
}
report.check.problems = checkReport(report)

mkdirSync(join(ROOT, outDir), { recursive: true })
const jsonPath = join(ROOT, outDir, 'traceability.json')
const mdPath = join(ROOT, outDir, 'README.md')
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n')
writeFileSync(mdPath, markdown(report) + '\n')

if (report.check.problems.length > 0) {
  for (const problem of report.check.problems) console.error(`[traceability] ${problem}`)
  process.exit(1)
}

if (values.check) {
  console.log(`[traceability] PASS ${outDir}/traceability.json`)
} else {
  console.log(`[traceability] wrote ${outDir}/traceability.json`)
}
