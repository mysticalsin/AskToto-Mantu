import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findUnpinnedUses } from './check-workflow-pins.mjs'

const workflow = readFileSync(join(__dirname, '../../.github/workflows/retained-profile-analysis.yml'), 'utf8')

describe('retained profile diagnostic workflow', () => {
  it('registers without executing and admits only manual main dispatches in the source repo', () => {
    expect(workflow).toContain('      - .github/workflows/retained-profile-analysis.yml')
    expect(workflow).toContain('(registration)')
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.repository == 'mysticalsin/AskToto-Mantu' && github.ref == 'refs/heads/main'"
    )
    expect(workflow).not.toMatch(/inputs:|workflow_call:|pull_request_target:|workflow_run:|schedule:/)
  })

  it('uses one read-only bounded Linux job, reviewed action pins and no application or installer route', () => {
    expect(workflow).toContain('  contents: read\n  actions: read')
    expect(workflow).toContain('    runs-on: ubuntu-24.04')
    expect(workflow).toContain('    timeout-minutes: 5')
    expect(workflow).toContain('          node-version: 22.22.3')
    expect(workflow).toContain('          persist-credentials: false')
    expect(workflow).toContain('  cancel-in-progress: false')
    expect(findUnpinnedUses(workflow)).toEqual([])
    expect(workflow).not.toMatch(
      /write\b|secrets\.|npm |npx |download-artifact|gh run download|candidate-scenarios|hdiutil|\.exe|\.dmg|cache:/
    )
  })

  it('uploads only the validated closed summary after success', () => {
    expect(workflow).toContain('run: node scripts/qa/retained-profile-analysis.mjs')
    expect(workflow).toContain("if: success() && steps.analysis.outcome == 'success'")
    expect(workflow).toContain('          path: retained-profile-summary.json')
    expect(workflow).toContain('          if-no-files-found: error')
    expect(workflow).toContain('          retention-days: 7')
    expect(workflow).not.toMatch(/always\(\)|continue-on-error|path:.*[*/]/)
  })
})
