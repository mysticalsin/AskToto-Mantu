import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRIAGE_LABELS,
  buildTriagePlan,
  checksAreGreen,
  evidenceExists,
  issueLooksLikeOperatorVisual
} from './github-triage.mjs'

const openPr = (number, override = {}) => ({
  number,
  title: `PR ${number}`,
  baseRefName: 'stale-base',
  labels: [],
  milestone: null,
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  ...override
})

const openIssue = (number, title = `Issue ${number}`, override = {}) => ({
  number,
  title,
  labels: [],
  milestone: null,
  ...override
})

test('M2-0025 plan creates the priority, rebase and 2.0 milestone primitives', () => {
  const plan = buildTriagePlan({ prs: [], issues: [] })
  assert.deepEqual(TRIAGE_LABELS.map((label) => label.name), ['P0', 'P1', 'P2', 'P3', 'needs-rebase'])
  assert.ok(plan.actions.some((action) => action.type === 'ensure_milestone' && action.title === '2.0'))
  for (const name of ['P0', 'P1', 'P2', 'P3', 'needs-rebase']) {
    assert.ok(plan.actions.some((action) => action.type === 'ensure_label' && action.name === name))
  }
})

test('M2-0025 plan merges clean PRs, retargets stale real fixes, and never rebases the Windows-signing PR', () => {
  const plan = buildTriagePlan({
    prs: [openPr(167), openPr(168), openPr(161), openPr(176)],
    issues: []
  })

  assert.ok(plan.actions.some((action) => action.type === 'merge_pr' && action.number === 167))
  assert.ok(plan.actions.some((action) => action.type === 'retarget_pr' && action.number === 168 && action.base === 'main'))
  assert.ok(plan.actions.some((action) => action.type === 'retarget_pr' && action.number === 161 && action.base === 'main'))
  assert.ok(plan.actions.some((action) => action.type === 'label' && action.subject.number === 176 && action.label === 'needs-rebase'))
  assert.equal(plan.actions.some((action) => action.type === 'retarget_pr' && action.number === 176), false)
  assert.equal(plan.actions.some((action) => action.type === 'merge_pr' && action.number === 176), false)
})

test('M2-0025 plan closes superseded and routed PRs with their replacement ticket pointers', () => {
  const plan = buildTriagePlan({
    prs: [openPr(156), openPr(159), openPr(160), openPr(178), openPr(179), openPr(157), openPr(187)],
    issues: []
  })
  for (const number of [156, 159, 160, 178]) {
    const action = plan.actions.find((candidate) => candidate.type === 'close_pr' && candidate.number === number)
    assert.match(action.body, /M2-0022/)
  }
  assert.match(plan.actions.find((action) => action.type === 'close_pr' && action.number === 179).body, /fidelity harness/)
  assert.match(plan.actions.find((action) => action.type === 'close_pr' && action.number === 157).body, /intelligence workspace/)
  assert.match(plan.actions.find((action) => action.type === 'close_pr' && action.number === 187).body, /M2-0022/)
})

test('M2-0025 plan blocks fixed-at-HEAD closures when a configured file:line evidence reference is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'metis-triage-evidence-'))
  try {
    mkdirSync(join(root, 'operator/src/spa'), { recursive: true })
    writeFileSync(join(root, 'operator/src/spa/router.test.ts'), 'only one line\n')
    const plan = buildTriagePlan({ prs: [], issues: [openIssue(104)], root })
    assert.deepEqual(plan.blockers, [
      'issue #104 evidence missing: operator/src/spa/router.test.ts:26',
      'issue #104 evidence missing: operator/src/spa/router.test.ts:48'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M2-0025 plan routes Operator visual issues only when the portal ticket is explicit', () => {
  const issue = openIssue(222, 'Operator visual layout is clipped')
  const blocked = buildTriagePlan({ prs: [], issues: [issue] })
  assert.match(blocked.blockers[0], /operator visual issue/i)
  const routed = buildTriagePlan({ prs: [], issues: [issue], operatorPortalTicket: 'M2-0099' })
  assert.equal(routed.blockers.length, 0)
  assert.match(routed.actions.find((action) => action.type === 'close_issue' && action.number === 222).body, /M2-0099/)
})

test('M2-0025 helpers classify green checks and Operator visual titles conservatively', () => {
  assert.equal(checksAreGreen([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), true)
  assert.equal(checksAreGreen([]), false)
  assert.equal(checksAreGreen([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), false)
  assert.equal(issueLooksLikeOperatorVisual({ title: 'Operator portal sidebar clips labels' }), true)
  assert.equal(issueLooksLikeOperatorVisual({ title: 'Provider rate limit regression' }), false)
})

test('M2-0025 evidenceExists accepts only existing file:line references', () => {
  const root = mkdtempSync(join(tmpdir(), 'metis-triage-ref-'))
  try {
    writeFileSync(join(root, 'proof.txt'), 'a\nb\n')
    assert.equal(evidenceExists('proof.txt:2', root), true)
    assert.equal(evidenceExists('proof.txt:3', root), false)
    assert.equal(evidenceExists('proof.txt', root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
