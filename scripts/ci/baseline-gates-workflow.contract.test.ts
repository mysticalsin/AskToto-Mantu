import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'baseline-gates.yml'), 'utf8').replace(/\r\n/g, '\n')

describe('M2-0263 baseline gates workflow', () => {
  it('is manual-only and measures both refs on every host OS', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/\n  push:/)
    expect(workflow).not.toMatch(/\n  pull_request:/)
    expect(workflow).toContain('baseline_ref:')
    expect(workflow).toContain('fix_ref:')
    expect(workflow).toContain('os: [ubuntu-latest, macos-latest, windows-latest]')
    expect(workflow).toContain('label: [baseline, fix]')
  })

  it('runs the tool from the dispatched branch against a separately checked-out ref and uploads the record', () => {
    expect(workflow).toContain('path: tool')
    expect(workflow).toContain('path: target')
    expect(workflow).toContain('node tool/scripts/ci/baseline-gates.mjs')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2')
  })

  it('has no release, deploy or tag side effects', () => {
    expect(workflow).not.toContain('npm run dist')
    expect(workflow).not.toContain('npm run release')
    expect(workflow).not.toContain('gh release')
    expect(workflow).not.toContain('git tag')
    expect(workflow).not.toContain('git push')
  })
})
