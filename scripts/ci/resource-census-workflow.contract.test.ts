import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findUnpinnedUses } from './check-workflow-pins.mjs'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'resource-census.yml'), 'utf8').replace(/\r\n/g, '\n')
const lines = workflow.split('\n')

function block(from: string[], header: string, indent: number): string[] {
  const start = from.findIndex((line) => line === header)
  expect(start, `block not found: ${header.trim()}`).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of from.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body
}

const job = (name: string) => block(lines, `  ${name}:`, 2)

function steps(name: string): string[] {
  const result: string[] = []
  for (const line of block(job(name), '    steps:', 4)) {
    if (/^ {6}- /.test(line)) result.push(line)
    else if (result.length) result[result.length - 1] += `\n${line}`
  }
  return result
}

function stepIndex(all: string[], fragment: string): number {
  const index = all.findIndex((step) => step.includes(fragment))
  expect(index, `step not found: ${fragment}`).toBeGreaterThan(-1)
  return index
}

function inputNames(): string[] {
  return block(lines, '    inputs:', 4)
    .filter((line) => /^ {6}[A-Za-z0-9_]+:/.test(line))
    .map((line) => line.trim().replace(/:$/, ''))
}

describe('resource-census.yml', () => {
  it('stays dispatch-only with the main-ref guard on both measurement jobs', () => {
    const on = block(lines, 'on:', 0).filter((line) => /^ {2}\S/.test(line))
    expect(on).toEqual(['  workflow_dispatch:'])
    expect(job('macos')).toContain("    if: github.ref == 'refs/heads/main'")
    expect(job('windows')).toContain("    if: github.ref == 'refs/heads/main'")
    expect(workflow).toContain('run-name: ${{ inputs.candidate_run')
  })

  it('declares release, candidate and baseline inputs', () => {
    expect(inputNames()).toEqual(['release_repo', 'release_tag', 'candidate_run', 'mac_sha256', 'win_sha256', 'baseline_run'])
    expect(block(block(lines, '    inputs:', 4), '      candidate_run:', 6)).toContain('        required: false')
    expect(block(block(lines, '    inputs:', 4), '      baseline_run:', 6)).toContain('        required: false')
  })

  it('uses contents and actions read permissions, no secrets and only SHA-pinned actions', () => {
    expect(block(lines, 'permissions:', 0).filter((line) => line.trim())).toEqual(['  contents: read', '  actions: read'])
    expect(lines.filter((line) => /^\s+permissions:/.test(line))).toEqual([])
    expect(workflow).not.toContain('secrets.')
    expect(findUnpinnedUses(workflow)).toEqual([])
  })

  it('resolves exactly one source before any download and validates the candidate sha256 for each leg', () => {
    for (const name of ['macos', 'windows']) {
      const all = steps(name)
      const resolve = stepIndex(all, 'Resolve artifact source')
      const release = stepIndex(all, 'Download the packaged release artifact')
      const candidate = stepIndex(all, 'Download the candidate artifact')
      expect(resolve).toBeLessThan(release)
      expect(resolve).toBeLessThan(candidate)
      expect(all[resolve]).toContain('candidate sha256 inputs require candidate_run')
      expect(all[resolve]).toContain('release source requires release_repo and release_tag')
      expect(all[resolve]).toContain('echo "source=candidate"')
      expect(all[resolve]).toContain('echo "source=release"')
      expect(all[release]).toContain("if: steps.source.outputs.source == 'release'")
      expect(all[release]).toContain('--repo "$RELEASE_REPO"')
      expect(all[release]).not.toContain('"$GITHUB_REPOSITORY"')
      expect(all[candidate]).toContain("if: steps.source.outputs.source == 'candidate'")
    }
    expect(steps('macos')[stepIndex(steps('macos'), 'Resolve artifact source')]).toContain('mac_sha256 is required')
    expect(steps('windows')[stepIndex(steps('windows'), 'Resolve artifact source')]).toContain('win_sha256 is required')
  })

  it('candidate source guards the qa-candidate run, verifies provenance and selects the installer by sha256', () => {
    const mac = steps('macos')[stepIndex(steps('macos'), 'Download the candidate artifact')]
    const win = steps('windows')[stepIndex(steps('windows'), 'Download the candidate artifact')]
    for (const step of [mac, win]) {
      expect(step).toContain('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$CANDIDATE_RUN"')
      expect(step).toContain('node scripts/qa/candidate-scenarios.mjs guard candidate-run.json "$CANDIDATE_RUN"')
      expect(step).toContain('--name candidate-provenance')
      expect(step).toContain('node scripts/qa/provenance.mjs verify provenance/provenance.json assets')
      expect(step).toContain('node scripts/qa/candidate-installer.mjs assets "$INSTALLER_SHA256"')
      expect(step).toContain('cp "$installer" "release-artifact/$(basename "$installer")"')
      expect(step).toContain('require(\'./provenance/provenance.json\').run.id')
    }
    expect(mac).toContain('--name candidate-mac')
    expect(mac).toContain('resource-census macOS candidate source requires the DMG installer')
    expect(win).toContain('--name candidate-win')
  })

  it('runs the same census states for both sources with the same seconds and no host floor override', () => {
    expect(workflow).not.toContain('METIS_QA_HOST_FLOOR_OVERRIDE')
    for (const name of ['macos', 'windows']) {
      const stateStep = steps(name)[stepIndex(steps(name), 'Measure hosted census states')]
      expect(stateStep).toContain('for state in cold-start settled-idle; do')
      expect(stateStep.match(/--seconds 300/g)?.length).toBe(2)
      expect(stateStep).toContain('--state parked-idle')
      expect(stateStep).toContain('--output census-output/')
      expect(stepIndex(steps(name), 'Measure hosted census states')).toBeGreaterThan(stepIndex(steps(name), 'Build parked hide synthetic profile'))
    }
  })

  it('records run identity with source, build provenance, artifact sha256 and no floor override', () => {
    for (const name of ['macos', 'windows']) {
      const identity = steps(name)[stepIndex(steps(name), 'Record run identity and file digests')]
      expect(identity).toContain('source: process.env.SOURCE')
      expect(identity).toContain('build_run_id: process.env.BUILD_RUN_ID || null')
      expect(identity).toContain('commit: process.env.SOURCE_COMMIT || null')
      expect(identity).toContain('artifactFileName: process.env.ARTIFACT_NAME || null')
      expect(identity).toContain('artifact_sha256: process.env.ARTIFACT_SHA256 || null')
      expect(identity).toContain('hostFloorOverride: false')
      expect(identity).toContain('hostMemoryBytes: totalmem()')
    }
  })

  it('downloads an optional baseline run, emits a report-only delta and uploads all census files with if: always()', () => {
    const mac = steps('macos')
    const win = steps('windows')
    expect(mac[stepIndex(mac, 'Compare with baseline run')]).toContain(
      "if: always() && inputs.baseline_run != '' && steps.source.outputs.source != ''"
    )
    expect(mac[stepIndex(mac, 'Compare with baseline run')]).toContain("resource-census-macos-*")
    expect(mac[stepIndex(mac, 'Compare with baseline run')]).toContain('scripts/qa/census/delta.mjs')
    expect(win[stepIndex(win, 'Compare with baseline run')]).toContain("resource-census-windows-*")
    for (const name of ['macos', 'windows']) {
      const upload = steps(name)[stepIndex(steps(name), 'actions/upload-artifact@')]
      expect(upload).toContain("if: always() && steps.source.outputs.source != ''")
      expect(upload).toContain('name: resource-census-')
      expect(upload).toContain('path: census-output/')
    }
  })
})
