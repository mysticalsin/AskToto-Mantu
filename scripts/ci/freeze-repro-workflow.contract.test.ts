import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'freeze-repro.yml'), 'utf8').replace(/\r\n/g, '\n')

describe('M2-0008 freeze repro workflow', () => {
  it('is manual-only and requires explicit artifact hashes for both hosted platforms', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/\n  push:/)
    expect(workflow).not.toMatch(/\n  pull_request:/)
    expect(workflow).not.toMatch(/\n  release:/)
    expect(workflow).toContain('macos_artifact_sha256:')
    expect(workflow).toContain('windows_artifact_sha256:')
    expect(workflow.match(/required: true/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('defaults to dry-run mode and exposes hosted-live as the only live choice', () => {
    expect(workflow).toContain('mode:')
    expect(workflow).toContain('type: choice')
    expect(workflow).toContain('default: dry-run')
    expect(workflow).toContain('- dry-run')
    expect(workflow).toContain('- hosted-live')
  })

  it('runs the public M2-0008 harness and checker without release publication side effects', () => {
    expect(workflow).toContain('bash scripts/qa/freeze-repro/run-matrix.sh')
    expect(workflow).toContain('node scripts/evidence/check.mjs --ticket M2-0008 --bundle out/m2-0008-freeze-repro')
    expect(workflow).toContain('--dry-run')
    expect(workflow).toContain('--hosted-live')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2')
    expect(workflow.match(/npm ci/g)).toHaveLength(2)
    expect(workflow).not.toContain('npm run dist')
    expect(workflow).not.toContain('npm run release')
    expect(workflow).not.toContain('npm run build')
    expect(workflow).not.toContain('gh release create')
  })

  it('covers hosted macOS and Windows artifact extraction paths', () => {
    expect(workflow).toContain('runs-on: macos-latest')
    expect(workflow).toContain("gh release download \"$RELEASE_TAG\" --repo \"$RELEASE_REPO\" --pattern 'Metis-*.dmg'")
    expect(workflow).toContain('hdiutil attach')
    expect(workflow).toContain('runs-on: windows-latest')
    expect(workflow).toContain("gh release download \"$RELEASE_TAG\" --repo \"$RELEASE_REPO\" --pattern 'Metis-Setup-*.exe'")
    expect(workflow).toContain('Start-Process')
  })

  it('downloads from the real 1.9.6 release, verifies SHA256SUMS before install, and only runs on main', () => {
    expect(workflow).toContain('default: mysticalsin/Metis-Releases')
    expect(workflow).toContain('default: v1.9.6-unsigned')
    expect(workflow).not.toContain('"$GITHUB_REPOSITORY" --pattern')
    expect(workflow.match(/--pattern 'SHA256SUMS\*'/g)).toHaveLength(2)
    expect(workflow.match(/node scripts\/qa\/verify-sha256sums\.mjs/g)).toHaveLength(2)
    expect(workflow.indexOf('verify-sha256sums.mjs')).toBeLessThan(workflow.indexOf('hdiutil attach'))
    expect(workflow.lastIndexOf('verify-sha256sums.mjs')).toBeLessThan(workflow.indexOf('Start-Process'))
    expect(workflow.match(/if: github\.ref == 'refs\/heads\/main'/g)).toHaveLength(2)
    expect(workflow).not.toContain('secrets.')
  })

  it('passes hosted-live only when requested and keeps the platform host labels explicit', () => {
    const m2_0008Mac = workflow.slice(
      workflow.indexOf('      - name: Run the M2-0008 hosted bundle check'),
      workflow.indexOf('      - name: Run the M2-0194 attribution bundle check')
    )
    const m2_0008Win = workflow.slice(
      workflow.lastIndexOf('      - name: Run the M2-0008 hosted bundle check'),
      workflow.lastIndexOf('      - name: Run the M2-0194 attribution bundle check')
    )
    const m2_0194Mac = workflow.slice(
      workflow.indexOf('      - name: Run the M2-0194 attribution bundle check'),
      workflow.indexOf('      - uses: actions/upload-artifact@')
    )
    const m2_0194Win = workflow.slice(
      workflow.lastIndexOf('      - name: Run the M2-0194 attribution bundle check'),
      workflow.lastIndexOf('      - uses: actions/upload-artifact@')
    )
    expect(workflow.match(/if \[\[ "\$\{\{ inputs\.mode \}\}" == hosted-live \]\]; then/g)).toHaveLength(2)
    expect(m2_0008Mac.match(/--hosted-live/g)).toHaveLength(1)
    expect(m2_0008Mac).toContain('--qa-host-label macos-latest')
    expect(m2_0008Mac.match(/--dry-run/g)).toHaveLength(1)
    expect(m2_0008Win.match(/--hosted-live/g)).toHaveLength(1)
    expect(m2_0008Win).toContain('--qa-host-label windows-latest')
    expect(m2_0008Win.match(/--dry-run/g)).toHaveLength(1)
    expect(m2_0194Mac.match(/--hosted-live/g)).toHaveLength(1)
    expect(m2_0194Win.match(/--hosted-live/g)).toBeNull()
    expect(m2_0194Win.match(/--dry-run/g)).toHaveLength(1)
    expect(workflow.match(/--hosted-live/g)).toHaveLength(3)
  })
})

describe('M2-0194 QA candidate mode of the freeze repro workflow', () => {
  it('takes a qa-candidate run id and downloads that run\'s provenance and installer with read-only permissions', () => {
    expect(workflow).toMatch(/\n {6}candidate_run:\n {8}description: >-\n[\s\S]*?required: false/)
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}actions: read\n/)
    expect(workflow).toContain('gh run download "$CANDIDATE_RUN" --repo "$GITHUB_REPOSITORY" --name candidate-provenance')
    expect(workflow).toContain('--name candidate-mac')
    expect(workflow).toContain('--name candidate-win')
    expect(workflow.match(/node scripts\/qa\/provenance\.mjs verify /g)).toHaveLength(2)
    expect(workflow).not.toContain('secrets.')
  })

  it('checks the candidate hash before anything is installed, and fails the job on a mismatch', () => {
    const mac = workflow.slice(workflow.indexOf('  macos:'), workflow.indexOf('  windows:'))
    const win = workflow.slice(workflow.indexOf('  windows:'))
    expect(mac.indexOf('provenance.mjs verify')).toBeLessThan(mac.indexOf('shasum -a 256 -c -'))
    expect(mac.indexOf('shasum -a 256 -c -')).toBeLessThan(mac.indexOf('hdiutil attach'))
    expect(win.indexOf('provenance.mjs verify')).toBeLessThan(win.indexOf('sha256sum -c -'))
    expect(win.indexOf('sha256sum -c -')).toBeLessThan(win.indexOf('Start-Process'))
    expect(win).toContain("-name 'Metis-Setup-*.exe'")
  })

  it('emits and checks the M2-0194 bundle only in candidate mode and keeps the main-only guard', () => {
    expect(workflow.match(/--candidate-run "\$CANDIDATE_RUN"/g)).toHaveLength(2)
    expect(workflow.match(/node scripts\/evidence\/check\.mjs --ticket M2-0194 --bundle out\/m2-0194-freeze-repro/g)).toHaveLength(2)
    expect(workflow).toContain('name: m2-0194-freeze-repro-macos')
    expect(workflow).toContain('name: m2-0194-freeze-repro-windows')
    expect(workflow.match(/if: inputs\.candidate_run == ''/g)).toHaveLength(2)
    expect(workflow.match(/if: inputs\.candidate_run != ''/g)).toHaveLength(4)
    for (const use of workflow.match(/uses: [^\n]+/g) ?? []) expect(use).toMatch(/@[0-9a-f]{40} #/)
  })
})
