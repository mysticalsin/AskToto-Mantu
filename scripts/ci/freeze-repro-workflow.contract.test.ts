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
    expect(workflow.match(/if \[\[ "\$\{\{ inputs\.mode \}\}" == hosted-live \]\]; then/g)).toHaveLength(2)
    expect(workflow.match(/--hosted-live/g)).toHaveLength(2)
    expect(workflow).toContain('--qa-host-label macos-latest')
    expect(workflow).toContain('--qa-host-label windows-latest')
    expect(workflow.match(/--dry-run/g)).toHaveLength(2)
  })
})
