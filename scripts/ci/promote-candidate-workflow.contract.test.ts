import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'promote-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')

describe('M2-0503 promote-candidate residuals input', () => {
  it('declares an optional residuals input that a dry run may omit', () => {
    const input = workflow.slice(workflow.indexOf('      residuals:'), workflow.indexOf('      confirm_version:'))
    expect(input).toContain('required: false')
    expect(input).toContain('type: string')
    expect(input).toContain('-F residuals=@file')
  })

  it('refuses publish=true without residuals, before any download or upload', () => {
    const guard = workflow.indexOf('[ "$PUBLISH" = true ] && [ -z "${RESIDUALS//[[:space:]]/}" ]')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(workflow.indexOf('actions/download-artifact'))
    expect(guard).toBeLessThan(workflow.indexOf('gh release create'))
  })

  it('passes residuals to prepare-release through env and a file, never interpolated into a shell line', () => {
    expect(workflow.match(/RESIDUALS: \$\{\{ inputs\.residuals \}\}/g)).toHaveLength(2)
    expect(workflow.match(/inputs\.residuals/g)).toHaveLength(2)
    expect(workflow).toContain('printf \'%s\' "$RESIDUALS" > "$RUNNER_TEMP/residuals.md"')
    expect(workflow).toContain('--residuals-file "$RUNNER_TEMP/residuals.md"')
    for (const line of workflow.split('\n')) {
      if (line.includes('inputs.residuals')) expect(line).toMatch(/^\s+RESIDUALS: \$\{\{ inputs\.residuals \}\}$/)
    }
  })
})
