import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'qa-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')

/** A job's text: from its two-space key to the next two-space key. No YAML library is a dependency here. */
function jobBlock(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^  [A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** The job's own `continue-on-error`, at job level (four-space indent). */
function jobContinueOnError(block: string): string | undefined {
  return block.match(/^ {4}continue-on-error: (.+)$/m)?.[1]
}

describe('QA candidate job st1-mac-dataless-synthetic (M2-0505, OD-36)', () => {
  const job = jobBlock('st1-mac-dataless-synthetic')

  it('runs on macOS after provenance', () => {
    expect(job).toContain('needs: provenance')
    expect(job).toContain('runs-on: macos-latest')
  })

  it('verifies the QA-identity variant and the promotable DMG against the provenance', () => {
    expect(job).toContain('name: candidate-mac-qa-identity')
    expect(job).toContain('provenance.mjs verify provenance/provenance.json assets mac-qa-identity')
    expect(job).toContain('name: candidate-mac\n')
    expect(job).toContain('provenance.mjs verify provenance/provenance.json assets-mac mac')
  })

  it('measures the synthetic dataless row with History off for five minutes', () => {
    expect(job).toContain('--fixtures synthetic-dataless')
    expect(job).toContain('--history off')
    expect(job).toContain('--minutes 5')
    expect(job).toContain('--out st1-report/st-1-macos-synthetic-dataless.json')
  })

  it('records the real-cloud dataless row as not run, with the SF_DATALESS probe under sudo', () => {
    expect(job).toContain('st-1-macos-real-dataless.json')
    expect(job).toContain('row: "dataless-real-cloud"')
    expect(job).toContain('verdict: "NOT_RUN_ON_HOSTED"')
    expect(job).toContain('measuredBy: "post-release field soak diagnostics"')
    expect(job).toContain('sudo python3')
    expect(job).toContain('sfDatalessProbe: { settable: $settable, errno: $errno')
    expect(job).toContain('sudo rm -f "$scratch"')
    expect(job).not.toMatch(/dataless-real-cloud[\s\S]*verdict: "PASS"/)
  })

  it('runs the DMG helper through stat-flags-fixture.sh --local-only and keeps its result', () => {
    expect(job).toContain('hdiutil attach')
    expect(job).toContain('Contents/Resources/mac-helper/metis-mac-helper')
    expect(job).toContain('scripts/qa/stat-flags-fixture.sh "$helper" --local-only')
    expect(job).toContain('stat-flags-report/stat-flags-macos.json')
    expect(job).toContain('datalessFileCheck: "NOT_RUN_ON_HOSTED"')
  })

  it('uploads the synthetic-dataless report and the stat-flags result even when a step failed', () => {
    for (const name of ['st-1-macos-synthetic-dataless', 'stat-flags-macos']) {
      const upload = job.split('- uses: actions/upload-artifact@').find((part) => part.includes(`name: ${name}\n`))
      expect(upload, `upload of ${name}`).toBeDefined()
      expect(upload).toContain('if: always()')
      expect(upload).toContain('if-no-files-found: error')
    }
  })

  it('has the same continue-on-error as st1-mac-fifo, so it is blocking exactly when that job is', () => {
    const fifo = jobContinueOnError(jobBlock('st1-mac-fifo'))
    expect(fifo).toBeDefined()
    expect(jobContinueOnError(job)).toBe(fifo)
  })

  it('is part of the self-test trigger for its own files', () => {
    expect(workflow).toContain('      - scripts/qa/stat-flags-fixture.sh')
  })
})
