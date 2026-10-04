import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contentFreeReport,
  parseArgs,
  sha256File,
  summarizeNewImages,
  validateInputs
} from './owner-camera.mjs'

describe('owner-camera runner tool', () => {
  it('requires explicit candidate run, dmg and sha256 inputs', () => {
    expect(() => validateInputs(parseArgs([]))).toThrow(/--dmg is required/)
    expect(() => parseArgs(['--dmg'])).toThrow(/requires a value/)
  })

  it('hashes the candidate bytes and reports only content-free image facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-camera-test-'))
    try {
      const dmg = join(root, 'Metis-1.0.0.dmg')
      writeFileSync(dmg, 'candidate')
      const sha = sha256File(dmg)
      const args = parseArgs(['--dmg', dmg, '--sha256', sha, '--candidate-run', '123', '--out', join(root, 'out')])
      validateInputs(args)

      const photos = join(root, 'photos')
      mkdirSync(photos)
      writeFileSync(join(photos, 'before.png'), 'old')
      const before = ['before.png']
      writeFileSync(join(photos, 'after.png'), 'new-bytes')
      const images = summarizeNewImages(before, photos)
      const report = contentFreeReport({
        appReport: {
          result: 'PASS',
          cameraDevicePresent: true,
          approvalPromptShown: true,
          explicitApprovalAccepted: true
        },
        images,
        args,
        deleted: true
      })

      expect(images).toMatchObject({ count: 1, bytes: 9 })
      expect(report).toMatchObject({
        result: 'PASS',
        camera_device_present: true,
        approval_prompt_shown: true,
        explicit_approval_accepted: true,
        image_files_created: 1,
        image_bytes: 9,
        image_deleted: true,
        build_run_id: '123',
        artifact_sha256: sha,
        environment: { kind: 'owner-mac', host: 'metis-owner-mac' }
      })
      expect(JSON.stringify(report)).not.toContain(root)
      expect(JSON.stringify(report)).not.toContain('after.png')

      expect(contentFreeReport({
        appReport: {
          result: 'PASS',
          cameraDevicePresent: true,
          approvalPromptShown: true,
          explicitApprovalAccepted: true
        },
        images,
        args,
        deleted: false
      }).result).toBe('FAIL')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves PRECONDITION when the candidate reports no camera grant', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-camera-test-'))
    try {
      const dmg = join(root, 'Metis-1.0.0.dmg')
      writeFileSync(dmg, 'candidate')
      const args = parseArgs(['--dmg', dmg, '--sha256', sha256File(dmg), '--candidate-run', '123'])
      const report = contentFreeReport({
        appReport: {
          result: 'PRECONDITION',
          reason: 'camera grant is denied',
          cameraDevicePresent: null,
          approvalPromptShown: false,
          explicitApprovalAccepted: false
        },
        images: { count: 0, bytes: 0, names: [] },
        args,
        deleted: true
      })

      expect(report.result).toBe('PRECONDITION')
      expect(report.reason).toMatch(/camera grant/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('owner-camera workflow contract', () => {
  const workflow = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'owner-camera.yml'), 'utf8')

  it('is manual-only, main-only, and runs on the owner Mac runner', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('.github/workflows/owner-camera.yml')
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain('runs-on: [self-hosted, metis-owner-mac]')
  })

  it('proves the fail-closed sandbox before download or camera execution', () => {
    const probe = workflow.indexOf('Prove owner-runner sandbox denies private state')
    const download = workflow.indexOf('Download candidate DMG')
    const run = workflow.indexOf('Verify and run the approved camera action')
    expect(probe).toBeGreaterThan(-1)
    expect(download).toBeGreaterThan(probe)
    expect(run).toBeGreaterThan(download)
    expect(workflow).toContain('bash scripts/hermetic/prove-owner-sandbox.sh')
    expect(workflow).toContain('OWNER_SANDBOX_PROFILE: owner-runner.sb')
  })

  it('verifies the named DMG sha256 and uploads only the job-scoped report directory', () => {
    expect(workflow).toContain('node scripts/qa/candidate-installer.mjs candidate "$MAC_SHA256" mac-dmg')
    expect(workflow).toContain('node scripts/qa/owner-camera.mjs')
    expect(workflow).toContain('--out owner-camera')
    expect(workflow).toContain('path: owner-camera/')
  })
})
