import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { findUnpinnedUses } from '../ci/check-workflow-pins.mjs'
import {
  ARTIFACT,
  SOURCE,
  verifyArtifactMetadata,
  verifyReportScope,
  verifyRunMetadata
} from './st1-current-profile-readback.mjs'

function runRecord() {
  return {
    id: SOURCE.runId,
    path: SOURCE.workflowPath,
    event: SOURCE.event,
    run_attempt: SOURCE.attempt,
    status: SOURCE.status,
    conclusion: SOURCE.conclusion,
    head_sha: SOURCE.headSha,
    head_branch: SOURCE.headBranch,
    repository: { id: SOURCE.repositoryId, full_name: SOURCE.repository },
    head_repository: { id: SOURCE.repositoryId, full_name: SOURCE.repository }
  }
}

function artifactRecord() {
  return {
    id: ARTIFACT.id,
    name: ARTIFACT.name,
    size_in_bytes: ARTIFACT.size,
    digest: `sha256:${ARTIFACT.sha256}`,
    expired: false,
    expires_at: '2030-01-01T00:00:00Z',
    workflow_run: {
      id: SOURCE.runId,
      repository_id: SOURCE.repositoryId,
      head_repository_id: SOURCE.repositoryId,
      head_sha: SOURCE.headSha
    }
  }
}

test('pins the failed source run and rejects any identity or outcome drift', () => {
  assert.equal(verifyRunMetadata(runRecord()), true)
  for (const [key, value] of [
    ['id', SOURCE.runId + 1],
    ['path', '.github/workflows/other.yml'],
    ['event', 'workflow_dispatch'],
    ['run_attempt', 2],
    ['status', 'in_progress'],
    ['conclusion', 'success'],
    ['head_sha', 'a'.repeat(40)],
    ['head_branch', 'main']
  ]) {
    assert.throws(() => verifyRunMetadata({ ...runRecord(), [key]: value }))
  }
  assert.throws(() => verifyRunMetadata({ ...runRecord(), repository: { id: 1, full_name: SOURCE.repository } }))
  assert.throws(() => verifyRunMetadata({ ...runRecord(), head_repository: { id: 1, full_name: SOURCE.repository } }))
})

test('pins artifact bytes and run scope, and rejects expired or replaced artifacts', () => {
  assert.equal(verifyArtifactMetadata(artifactRecord(), Date.parse('2029-01-01T00:00:00Z')), true)
  for (const [key, value] of [
    ['id', ARTIFACT.id + 1],
    ['name', 'replacement'],
    ['size_in_bytes', ARTIFACT.size + 1],
    ['digest', `sha256:${'f'.repeat(64)}`],
    ['expired', true],
    ['expires_at', '2020-01-01T00:00:00Z']
  ]) {
    assert.throws(() =>
      verifyArtifactMetadata({ ...artifactRecord(), [key]: value }, Date.parse('2029-01-01T00:00:00Z'))
    )
  }
  assert.throws(() =>
    verifyArtifactMetadata(
      { ...artifactRecord(), workflow_run: { ...artifactRecord().workflow_run, head_sha: 'b'.repeat(40) } },
      Date.parse('2029-01-01T00:00:00Z')
    )
  )
})

test('refuses reports outside the fixed failed control scope', () => {
  assert.throws(() => verifyReportScope({ harness: 'ST-1', row: 'fifo', verdict: 'FAIL' }))
  assert.throws(() => verifyReportScope({ harness: 'ST-1', row: 'none', complete: false, verdict: 'FAIL' }))
  assert.throws(() => verifyReportScope({ harness: 'ST-1', row: 'none', complete: true, verdict: 'PASS' }))
})

test('readback workflow is branch-guarded, read-only, pinned, and runs pure tests before API access', () => {
  const workflow = readFileSync('.github/workflows/st1-current-profile-readback.yml', 'utf8')
  const historicalGate = readFileSync('.github/workflows/qa-candidate.yml', 'utf8')
  assert.match(workflow, /branches:\s*\n\s*- m2\/M2-0433-st1-current-profile-readback/)
  assert.match(workflow, /github\.event_name == 'push'/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/m2\/M2-0433-st1-current-profile-readback'/)
  assert.match(workflow, /contents: read\s+actions: read/)
  assert.match(workflow, /timeout-minutes: 5/)
  assert.match(workflow, /persist-credentials: false/)
  assert.ok(
    workflow.indexOf('node --test scripts/qa/st1-current-profile-readback.node.test.mjs') <
      workflow.indexOf('GH_TOKEN:')
  )
  assert.ok(workflow.includes('node scripts/qa/st1-current-profile-readback.mjs'))
  assert.deepEqual(findUnpinnedUses(workflow), [])
  assert.ok(historicalGate.includes('no-late-samples'))
  assert.ok(historicalGate.includes('loop.maxMs'))
  assert.ok(historicalGate.includes('write.maxMs'))
})
