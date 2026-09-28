#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TRIAGE_MILESTONE = '2.0'

export const TRIAGE_LABELS = [
  { name: 'P0', color: 'B60205', description: 'Highest priority: blocks 2.0 or release-critical evidence.' },
  { name: 'P1', color: 'D93F0B', description: 'High priority: required 2.0 work or verified defect.' },
  { name: 'P2', color: 'FBCA04', description: 'Normal priority: planned 2.0 work or follow-up.' },
  { name: 'P3', color: '0E8A16', description: 'Low priority: superseded, duplicate, cleanup, or archival route.' },
  { name: 'needs-rebase', color: '5319E7', description: 'Branch needs a rebase or retarget before review can continue.' }
]

const PR_DISPOSITIONS = new Map([
  [167, { kind: 'merge_when_green', priority: 'P1' }],
  [186, { kind: 'merge_when_green', priority: 'P1' }],
  [200, { kind: 'merge_when_green', priority: 'P1' }],
  [168, { kind: 'retarget_main', priority: 'P1' }],
  [161, { kind: 'retarget_main', priority: 'P1' }],
  [176, { kind: 'coordinate_windows_signing_rebase', priority: 'P0', labels: ['needs-rebase'] }],
  [156, { kind: 'close_superseded', priority: 'P3', ticket: 'M2-0022' }],
  [159, { kind: 'close_superseded', priority: 'P3', ticket: 'M2-0022' }],
  [160, { kind: 'close_superseded', priority: 'P3', ticket: 'M2-0022' }],
  [178, { kind: 'close_superseded', priority: 'P3', ticket: 'M2-0022' }],
  [179, { kind: 'route_ticket', priority: 'P2', ticket: 'M2-0023', route: 'fidelity harness' }],
  [157, { kind: 'route_ticket', priority: 'P2', ticket: 'M2-0024', route: 'intelligence workspace' }]
])

const DOCK_LANE_PRS = new Set([187, 188, 189, 190, 191, 192, 193, 194])

const ISSUE_DISPOSITIONS = new Map([
  [104, {
    kind: 'close_fixed',
    priority: 'P1',
    evidence: ['operator/src/spa/router.test.ts:26', 'operator/src/spa/router.test.ts:48']
  }],
  [105, {
    kind: 'close_fixed',
    priority: 'P1',
    evidence: ['operator/src/ui.console.test.ts:80', 'operator/src/ui.console.test.ts:98']
  }],
  [117, {
    kind: 'close_fixed',
    priority: 'P1',
    evidence: [
      'src/main/exhaustion-routing.contract.test.ts:13',
      'src/main/llm/provider-health.test.ts:122'
    ]
  }],
  [183, {
    kind: 'close_fixed',
    priority: 'P2',
    evidence: ['src/main/screen-preprocess.ts:42', 'src/main/screen-preprocess.test.ts:522']
  }],
  [184, {
    kind: 'close_duplicate',
    priority: 'P3',
    duplicateOf: 185,
    evidence: ['runs/FITO-185-X-loading-once.md:22', 'runs/FITO-185-AB-idempotent-boot.md:25']
  }],
  [185, {
    kind: 'close_duplicate',
    priority: 'P3',
    duplicateOf: 185,
    evidence: ['runs/FITO-185-X-loading-once.md:22', 'runs/FITO-185-AB-idempotent-boot.md:30']
  }]
])

const DEFAULT_OUTPUT_DIR = join('out', 'm2-0025-triage')
const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

function parseArgs(argv) {
  const args = {
    apply: false,
    out: DEFAULT_OUTPUT_DIR,
    repo: process.env.GITHUB_REPOSITORY || '',
    operatorPortalTicket: process.env.METIS_OPERATOR_PORTAL_TICKET || '',
    operatorBranch: process.env.METIS_OPERATOR_BRANCH || 'codex/operator-ux-rock-1'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') args.apply = true
    else if (arg === '--dry-run') args.apply = false
    else if (arg === '--out') args.out = requiredValue(argv, ++i, arg)
    else if (arg === '--repo') args.repo = requiredValue(argv, ++i, arg)
    else if (arg === '--operator-portal-ticket') args.operatorPortalTicket = requiredValue(argv, ++i, arg)
    else if (arg === '--operator-branch') args.operatorBranch = requiredValue(argv, ++i, arg)
    else if (arg === '--help') args.help = true
    else throw new Error(`Unsupported argument: ${arg}`)
  }
  return args
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function ghJson(args, options = {}) {
  const stdout = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    env: process.env
  })
  return stdout.trim() ? JSON.parse(stdout) : null
}

function gh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    env: process.env
  }).trim()
}

export function evidenceExists(ref, root = REPO_ROOT) {
  const match = /^(.+):([1-9][0-9]*)$/.exec(ref)
  if (!match) return false
  const [, file, lineText] = match
  const path = join(root, file)
  if (!existsSync(path)) return false
  const line = Number(lineText)
  return readFileSync(path, 'utf8').split(/\r?\n/).length >= line
}

export function checksAreGreen(statusCheckRollup = []) {
  return statusCheckRollup.length > 0 && statusCheckRollup.every((check) => {
    const conclusion = check.conclusion || check.state || check.status
    return ['SUCCESS', 'success', 'COMPLETED', 'completed', 'PASS', 'PASSING', 'NEUTRAL', 'SKIPPED']
      .includes(String(conclusion))
  })
}

export function issueLooksLikeOperatorVisual(issue) {
  const title = String(issue.title || '').toLowerCase()
  return title.includes('operator') && /(visual|ui|ux|portal|console|sidebar|layout|map)/.test(title)
}

function itemLabels(item) {
  return new Set((item.labels || []).map((label) => label.name || label))
}

function addLabelAction(actions, subject, label, labels) {
  if (!labels.has(label)) actions.push({ type: 'label', subject, label })
}

function addMilestoneAction(actions, subject, item) {
  if ((item.milestone?.title || '') !== TRIAGE_MILESTONE) {
    actions.push({ type: 'milestone', subject, milestone: TRIAGE_MILESTONE })
  }
}

function addCommentAction(actions, subject, body) {
  actions.push({ type: 'comment', subject, body })
}

export function buildTriagePlan({ prs, issues, operatorPortalTicket = '', operatorBranch = 'codex/operator-ux-rock-1', root = REPO_ROOT }) {
  const actions = [
    { type: 'ensure_milestone', title: TRIAGE_MILESTONE },
    ...TRIAGE_LABELS.map((label) => ({ type: 'ensure_label', ...label })),
    { type: 'ensure_operator_branch_pr', branch: operatorBranch, base: 'main', milestone: TRIAGE_MILESTONE, label: 'P1' }
  ]
  const blockers = []

  for (const pr of prs) {
    const subject = { kind: 'pr', number: pr.number }
    const labels = itemLabels(pr)
    const disposition = PR_DISPOSITIONS.get(pr.number) ||
      (DOCK_LANE_PRS.has(pr.number) ? { kind: 'route_ticket', priority: 'P2', ticket: 'M2-0022', route: 'dock lane' } : null)
    addMilestoneAction(actions, subject, pr)
    addLabelAction(actions, subject, disposition?.priority || 'P2', labels)
    for (const label of disposition?.labels || []) addLabelAction(actions, subject, label, labels)

    if (!disposition) continue
    if (disposition.kind === 'merge_when_green') {
      actions.push(checksAreGreen(pr.statusCheckRollup)
        ? { type: 'merge_pr', number: pr.number, method: 'squash' }
        : { type: 'enable_auto_merge', number: pr.number, method: 'squash', reason: 'waiting for green CI' })
    } else if (disposition.kind === 'retarget_main') {
      if (pr.baseRefName !== 'main') actions.push({ type: 'retarget_pr', number: pr.number, base: 'main' })
    } else if (disposition.kind === 'coordinate_windows_signing_rebase') {
      addCommentAction(actions, subject, 'M2-0025 triage: marked `needs-rebase`; rebase only in coordination with the Windows-signing snapshot owner. This workflow does not touch the signing worktree.')
    } else if (disposition.kind === 'close_superseded') {
      actions.push({ type: 'close_pr', number: pr.number, body: `M2-0025 triage: closing as superseded. Replacement work is tracked by ${disposition.ticket}; dock-lane PRs #187-#194 remain with that ticket.` })
    } else if (disposition.kind === 'route_ticket') {
      actions.push({ type: 'close_pr', number: pr.number, body: `M2-0025 triage: routing this ${disposition.route} work to ${disposition.ticket}.` })
    }
  }

  for (const issue of issues) {
    const subject = { kind: 'issue', number: issue.number }
    const labels = itemLabels(issue)
    const disposition = ISSUE_DISPOSITIONS.get(issue.number)
    addMilestoneAction(actions, subject, issue)
    addLabelAction(actions, subject, disposition?.priority || 'P2', labels)

    if (disposition?.evidence) {
      for (const ref of disposition.evidence) {
        if (!evidenceExists(ref, root)) blockers.push(`issue #${issue.number} evidence missing: ${ref}`)
      }
    }
    if (disposition?.kind === 'close_fixed') {
      actions.push({ type: 'close_issue', number: issue.number, body: fixedIssueBody(issue.number, disposition.evidence) })
    } else if (disposition?.kind === 'close_duplicate') {
      actions.push({
        type: 'close_issue',
        number: issue.number,
        body: `M2-0025 triage: closing as duplicate of the FITO-185 run. Evidence: ${disposition.evidence.join(', ')}.`
      })
    } else if (!disposition && issueLooksLikeOperatorVisual(issue)) {
      if (!operatorPortalTicket) {
        blockers.push(`issue #${issue.number} looks like an Operator visual issue; pass --operator-portal-ticket before applying`)
      } else {
        actions.push({ type: 'close_issue', number: issue.number, body: `M2-0025 triage: routing Operator visual work to ${operatorPortalTicket}.` })
      }
    }
  }

  return { milestone: TRIAGE_MILESTONE, labels: TRIAGE_LABELS, actions, blockers }
}

function fixedIssueBody(number, evidence) {
  return `M2-0025 triage: closing as fixed at HEAD. Public evidence: ${evidence.join(', ')}.`
}

function subjectArg(subject) {
  return `${subject.kind === 'pr' ? 'pr' : 'issue'} ${subject.number}`
}

function applyAction(action, repo) {
  if (action.type === 'ensure_label') {
    try {
      gh(['label', 'create', action.name, '--color', action.color, '--description', action.description, '--repo', repo])
    } catch {
      gh(['label', 'edit', action.name, '--color', action.color, '--description', action.description, '--repo', repo])
    }
  } else if (action.type === 'ensure_milestone') {
    const milestones = ghJson(['api', '--method', 'GET', `repos/${repo}/milestones`, '-f', 'state=all'])
    const existing = milestones.find((milestone) => milestone.title === action.title)
    if (!existing) gh(['api', '--method', 'POST', `repos/${repo}/milestones`, '-f', `title=${action.title}`])
  } else if (action.type === 'milestone') {
    gh([action.subject.kind, 'edit', String(action.subject.number), '--milestone', action.milestone, '--repo', repo])
  } else if (action.type === 'label') {
    gh([action.subject.kind, 'edit', String(action.subject.number), '--add-label', action.label, '--repo', repo])
  } else if (action.type === 'comment') {
    gh([action.subject.kind, 'comment', String(action.subject.number), '--body', action.body, '--repo', repo])
  } else if (action.type === 'retarget_pr') {
    gh(['pr', 'edit', String(action.number), '--base', action.base, '--repo', repo])
  } else if (action.type === 'enable_auto_merge') {
    gh(['pr', 'merge', String(action.number), '--auto', `--${action.method}`, '--repo', repo])
  } else if (action.type === 'merge_pr') {
    gh(['pr', 'merge', String(action.number), `--${action.method}`, '--repo', repo])
  } else if (action.type === 'close_pr') {
    gh(['pr', 'close', String(action.number), '--comment', action.body, '--repo', repo])
  } else if (action.type === 'close_issue') {
    gh(['issue', 'close', String(action.number), '--comment', action.body, '--repo', repo])
  } else if (action.type === 'ensure_operator_branch_pr') {
    const existing = ghJson(['pr', 'list', '--head', action.branch, '--state', 'open', '--json', 'number', '--repo', repo])
    let number = existing[0]?.number
    if (!number) {
      gh(['pr', 'create', '--head', action.branch, '--base', action.base, '--title',
        'Fix Operator UX rough edges [M2-0025]', '--body',
        'Opened by the M2-0025 triage workflow after confirming the upstream branch exists.',
        '--repo', repo])
      number = ghJson(['pr', 'list', '--head', action.branch, '--state', 'open', '--json', 'number', '--repo', repo])[0]?.number
    }
    if (number) {
      gh(['pr', 'edit', String(number), '--milestone', action.milestone, '--add-label', action.label, '--repo', repo])
    }
  } else {
    throw new Error(`Unsupported action type: ${action.type}`)
  }
}

function writeReport(outDir, report) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'triage-plan.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(outDir, 'triage-plan.md'), markdownReport(report))
}

function markdownReport(report) {
  const lines = [
    '# M2-0025 GitHub Triage',
    '',
    `Mode: ${report.apply ? 'apply' : 'dry-run'}`,
    `Milestone: ${report.plan.milestone}`,
    `Open PRs observed: ${report.observed.prs.length}`,
    `Open issues observed: ${report.observed.issues.length}`,
    `Blockers: ${report.plan.blockers.length}`,
    '',
    '## Actions',
    ''
  ]
  for (const action of report.plan.actions) {
    lines.push(`- ${action.type}${action.subject ? ` ${subjectArg(action.subject)}` : ''}${action.number ? ` #${action.number}` : ''}`)
  }
  if (report.plan.blockers.length) {
    lines.push('', '## Blockers', '')
    for (const blocker of report.plan.blockers) lines.push(`- ${blocker}`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node scripts/github-triage.mjs [--dry-run|--apply] --repo owner/name [--out out/dir] [--operator-portal-ticket M2-####]')
    return
  }
  if (!args.repo) throw new Error('--repo or GITHUB_REPOSITORY is required')

  const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '200', '--json',
    'number,title,baseRefName,headRefName,labels,milestone,isDraft,mergeStateStatus,statusCheckRollup', '--repo', args.repo])
  const issues = ghJson(['issue', 'list', '--state', 'open', '--limit', '200', '--json',
    'number,title,labels,milestone', '--repo', args.repo])
  const plan = buildTriagePlan({ prs, issues, operatorPortalTicket: args.operatorPortalTicket, operatorBranch: args.operatorBranch })
  const report = { ticket: 'M2-0025', apply: args.apply, observed: { prs, issues }, plan }

  if (args.apply && plan.blockers.length) {
    writeReport(args.out, report)
    throw new Error(`Refusing to apply with blockers:\n${plan.blockers.join('\n')}`)
  }
  if (args.apply) {
    for (const action of plan.actions) applyAction(action, args.repo)
  }
  writeReport(args.out, report)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[github-triage] FAIL — ${error.message}`)
    process.exitCode = 1
  })
}
