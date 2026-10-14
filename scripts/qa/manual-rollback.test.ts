import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_MACOS_SHA256,
  BASELINE_WINDOWS_SHA256,
  TARGET_VERSION,
  baselineChecksumProblems,
  baselineReleaseProblems,
  candidateBindingProblems,
  cleanShutdownAcknowledged,
  createAttachmentReceipt,
  createManualRollbackReport,
  finalizeManualRollbackResult,
  markAttachmentTransportClosed,
  markExecutionFailure,
  manualRollbackReportProblems,
  releaseAttachmentReceipt
} from './manual-rollback.mjs'
import { VARIANTS } from './provenance.mjs'

const REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = 1282463398
const COMMIT = 'a'.repeat(40)
const RUN_ID = 4242
const ATTEMPT = 3
const WIN_SHA = 'b'.repeat(64)
const MAC_SHA = 'c'.repeat(64)
const expected = { runId: RUN_ID, attempt: ATTEMPT, sha256: WIN_SHA }

function provenanceFixture() {
  return {
    schema: 2,
    repository: REPOSITORY,
    commit: COMMIT,
    version: TARGET_VERSION,
    run: { id: RUN_ID, attempt: ATTEMPT },
    builds: Object.entries(VARIANTS).map(([variant, config], index) => ({
      variant,
      artifact: `candidate-${variant}`,
      platform: config.platform,
      assets: config.assets(TARGET_VERSION).map((name, assetIndex) => ({
        name,
        size: 100 + index + assetIndex,
        sha256:
          variant === 'win' ? WIN_SHA : variant === 'mac' && name.endsWith('.dmg') ? MAC_SHA : `${index + 1}`.repeat(64)
      }))
    }))
  }
}

function runFixture() {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    name: 'QA candidate',
    path: '.github/workflows/qa-candidate.yml@main',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: COMMIT,
    status: 'completed',
    conclusion: 'success',
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    head_repository: { id: REPOSITORY_ID, full_name: REPOSITORY }
  }
}

function passingReport() {
  const report = createManualRollbackReport({
    run_id: RUN_ID,
    attempt: ATTEMPT,
    commit: COMMIT,
    version: TARGET_VERSION,
    windows_installer_sha256: WIN_SHA,
    macos_dmg_sha256: MAC_SHA
  })
  report.outcome = 'PARTIAL_BLOCKED'
  report.rows = report.rows.map((row) => ({ ...row, status: 'PASS', code: null }))
  report.windows.status = 'PASS'
  report.windows.meeting_count = 1
  report.windows.exact_meeting_bytes_preserved = true
  for (const [name, phase] of Object.entries(report.windows.phases)) {
    Object.assign(phase, {
      version: name === 'candidate' ? TARGET_VERSION : '1.9.6',
      settings_encrypted: true,
      settings_verified: true,
      meeting_encrypted: true,
      meeting_verified: true,
      notes_verified: true,
      history_verified: true
    })
  }
  report.cleanup = {
    status: 'ACKNOWLEDGED',
    isolated_profile_removed: true,
    install_root_removed: true,
    input_staging_removed: true,
    attachment_released: true,
    owned_processes_gone: true
  }
  return report
}

describe('manual rollback provenance and report contracts', () => {
  it('binds a successful QA candidate attempt, provenance, and exact Windows installer digest', () => {
    expect(candidateBindingProblems(runFixture(), provenanceFixture(), expected)).toEqual([])
  })

  it('rejects run, attempt, repository, commit, provenance, and installer mismatches', () => {
    const run = runFixture()
    const provenance = provenanceFixture()
    expect(candidateBindingProblems({ ...run, run_attempt: ATTEMPT - 1 }, provenance, expected)).toContain(
      'run-attempt-mismatch'
    )
    expect(
      candidateBindingProblems(run, { ...provenance, run: { id: RUN_ID, attempt: ATTEMPT - 1 } }, expected)
    ).toContain('candidate-provenance-mismatch')
    expect(
      candidateBindingProblems({ ...run, repository: { id: 1, full_name: 'attacker/repo' } }, provenance, expected)
    ).toContain('run-repository-mismatch')
    expect(candidateBindingProblems({ ...run, head_sha: 'd'.repeat(40) }, provenance, expected)).toContain(
      'candidate-provenance-mismatch'
    )
    expect(candidateBindingProblems({ ...run, event: 'push' }, provenance, expected)).toContain('run-ref-mismatch')
    expect(candidateBindingProblems({ ...run, conclusion: 'failure' }, provenance, expected)).toContain(
      'run-not-successful'
    )
    expect(candidateBindingProblems(run, provenance, { ...expected, sha256: 'e'.repeat(64) })).toContain(
      'candidate-windows-asset-mismatch'
    )
  })

  it('requires the pinned public Windows release checksum entry and rejects a different digest or filename', () => {
    expect(baselineChecksumProblems(`${BASELINE_WINDOWS_SHA256}  Metis-Setup-1.9.6.exe\n`)).toEqual([])
    expect(baselineChecksumProblems(`${'f'.repeat(64)}  Metis-Setup-1.9.6.exe\n`)).toContain(
      'baseline-checksum-manifest-mismatch'
    )
    expect(baselineChecksumProblems(`${BASELINE_WINDOWS_SHA256}  Metis-Portable-1.9.6.exe\n`)).toContain(
      'baseline-checksum-manifest-mismatch'
    )
    expect(
      baselineReleaseProblems(
        Buffer.from('different installer bytes'),
        `${BASELINE_WINDOWS_SHA256}  Metis-Setup-1.9.6.exe\n`
      )
    ).toContain('baseline-installer-digest-mismatch')
  })

  it('accepts only complete passing Windows recovery rows and an explicit blocked macOS row', () => {
    const report = passingReport()
    expect(report.windows.baseline_installer).toBe('Metis-Setup-1.9.6.exe')
    expect(report.windows.candidate_installer).toBe('Metis-Setup-1.9.7.exe')
    expect(report.windows.baseline_installer_sha256).toBe(BASELINE_WINDOWS_SHA256)
    expect(report.macos.baseline_dmg).toBe('Metis-1.9.6.dmg')
    expect(report.macos.candidate_dmg).toBe('Metis-1.9.7.dmg')
    expect(report.macos.baseline_dmg_sha256).toBe(BASELINE_MACOS_SHA256)
    expect(report.macos).toMatchObject({ status: 'BLOCKED', execution: 'NEVER_RUN', attempted: false })
    expect(manualRollbackReportProblems(report, expected)).toEqual([])

    const skipped = structuredClone(report)
    skipped.rows[2].status = 'SKIPPED'
    expect(manualRollbackReportProblems(skipped, expected)).toContain('row-not-passing:baseline-encrypted-profile')

    const missing = structuredClone(report)
    missing.rows.pop()
    expect(manualRollbackReportProblems(missing, expected)).toContain('rows-incomplete')

    const wrongArtifact = structuredClone(report)
    wrongArtifact.identity!.windows_installer_sha256 = 'e'.repeat(64)
    wrongArtifact.windows.candidate_installer_sha256 = 'e'.repeat(64)
    expect(manualRollbackReportProblems(wrongArtifact, expected)).toContain('identity-windows-sha-mismatch')

    const macClaimedPass = structuredClone(report)
    macClaimedPass.macos.status = 'PASS'
    macClaimedPass.macos.attempted = true
    expect(manualRollbackReportProblems(macClaimedPass, expected)).toContain('macos-blocker-not-explicit')

    const unclean = structuredClone(report)
    unclean.cleanup.input_staging_removed = false
    expect(manualRollbackReportProblems(unclean, expected)).toContain('cleanup-unacknowledged')

    const attachUnreleased = structuredClone(report)
    attachUnreleased.cleanup.attachment_released = false
    expect(manualRollbackReportProblems(attachUnreleased, expected)).toContain('cleanup-unacknowledged')

    expect(manualRollbackReportProblems(null as never, expected)).toContain('report-shape-invalid')
  })

  it('keeps a final shutdown failure from being masked by a successful profile readback', () => {
    const report = passingReport()
    markExecutionFailure(report, 'rollback-encrypted-profile-readback', 'app-teardown-unacknowledged')

    expect(report.rows.find((row) => row.id === 'rollback-encrypted-profile-readback')).toMatchObject({
      status: 'FAIL',
      code: 'app-teardown-unacknowledged'
    })
    expect(finalizeManualRollbackResult(report, false)).toBe('FAIL')
    expect(report.outcome).toBe('FAIL')
    expect(manualRollbackReportProblems(report, expected)).toContain(
      'row-not-passing:rollback-encrypted-profile-readback'
    )
  })

  it('fails final status when execution failed even if every report row and cleanup are marked passing', () => {
    const report = passingReport()

    expect(finalizeManualRollbackResult(report, true)).toBe('FAIL')
    expect(report.outcome).toBe('FAIL')
    expect(manualRollbackReportProblems(report, expected)).toContain('windows-not-passing')
  })

  it('accepts only a natural zero exit with released attachment and no forced termination or survivors', () => {
    const cleanExit = {
      quitRequested: true,
      transportClosed: true,
      attachmentReleased: true,
      exitCode: 0,
      signal: null,
      forcedTermination: false,
      survivors: 0
    }
    expect(cleanShutdownAcknowledged(cleanExit)).toBe(true)
    expect(cleanShutdownAcknowledged({ ...cleanExit, exitCode: 1 })).toBe(false)
    expect(cleanShutdownAcknowledged({ ...cleanExit, signal: 'SIGTERM' })).toBe(false)
    expect(cleanShutdownAcknowledged({ ...cleanExit, forcedTermination: true })).toBe(false)
    expect(cleanShutdownAcknowledged({ ...cleanExit, survivors: 1 })).toBe(false)
    expect(cleanShutdownAcknowledged({ ...cleanExit, attachmentReleased: false })).toBe(false)
  })

  it('retains an uncertain attach receipt until a late transport release is acknowledged', async () => {
    const unresolved = createAttachmentReceipt(null)
    expect(await releaseAttachmentReceipt(unresolved)).toBe(false)
    expect(unresolved.released).toBe(false)

    let attempts = 0
    const receipt = createAttachmentReceipt({
      transportUncertain: true,
      lateRelease: async () => {
        attempts += 1
        return attempts > 1
      }
    })

    expect(await releaseAttachmentReceipt(receipt)).toBe(false)
    expect(receipt.released).toBe(false)
    expect(await releaseAttachmentReceipt(receipt)).toBe(true)
    expect(receipt.released).toBe(true)
  })

  it('does not acknowledge a live browser transport until close succeeds', async () => {
    const receipt = createAttachmentReceipt({
      browser: {},
      transportUncertain: false,
      lateRelease: null
    })

    expect(await releaseAttachmentReceipt(receipt)).toBe(false)
    expect(receipt.released).toBe(false)
    expect(markAttachmentTransportClosed(receipt, true)).toBe(true)
    expect(await releaseAttachmentReceipt(receipt)).toBe(true)
    expect(receipt.released).toBe(true)
  })

  it('keeps the lane manual, hosted, attempt-bound, and separate from the upgrade scenario registry', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/manual-rollback.yml', import.meta.url), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain('runs-on: windows-latest')
    expect(workflow).toContain('/attempts/$($env:CANDIDATE_ATTEMPT)')
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('manual-rollback.mjs verify')
    expect(workflow).toContain('Metis-Setup-1.9.6.exe')
    expect(workflow).not.toContain('candidate-scenarios')
  })

  it('captures launch-time process identities and checks survivors through teardown before cleanup', () => {
    const runner = readFileSync(new URL('./manual-rollback.mjs', import.meta.url), 'utf8')
    const launchIndex = runner.indexOf('const launched = launchPackagedCdp')
    const captureIndex = runner.indexOf(
      'rememberOwnedProcesses(registry, launched.child.pid, installRoot)',
      launchIndex
    )
    const attachIndex = runner.indexOf('attachment = await attachOwnedCdp', launchIndex)
    expect(launchIndex).toBeGreaterThanOrEqual(0)
    expect(captureIndex).toBeGreaterThan(launchIndex)
    expect(captureIndex).toBeLessThan(attachIndex)
    expect(runner).toContain('survivors([...registry.values()], listProcesses')
    expect(runner).toContain('currentOwnedSurvivors(ownedProcessRegistry, paths.installRoot)')
    expect(runner).toContain('ownedProcessesGone = remaining.length === 0')
    expect(runner).toContain('for (const receipt of attachmentReceipts)')
    expect(runner).toContain('if (ownedProcessesGone && attachmentsReleased)')
  })

  it('emits only content-free recovery metadata and never records synthetic note or transcript text', () => {
    const report = passingReport()
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('Synthetic QA note')
    expect(serialized).not.toContain('Synthetic transcript marker')
    expect(Object.keys(report)).toEqual(['schema', 'outcome', 'identity', 'rows', 'windows', 'macos', 'cleanup'])
  })
})
