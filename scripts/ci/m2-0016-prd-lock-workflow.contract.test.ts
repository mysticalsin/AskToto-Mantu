import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'm2-0016-prd-lock.yml'), 'utf8').replace(/\r\n/g, '\n')

describe('M2-0016 PRD lock workflow', () => {
  it('runs only on manual dispatch', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('\n  push:')
    expect(workflow).not.toContain('\n  release:')
  })

  it('builds and uploads the public-safe generated artifact', () => {
    expect(workflow).toContain('node scripts/trace/build-traceability.mjs --check --out out/m2-0016-prd-lock')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2')
    expect(workflow).toContain('name: m2-0016-prd-lock')
    expect(workflow).toContain('path: out/m2-0016-prd-lock/')
    expect(workflow).not.toContain('npm test')
    expect(workflow).not.toContain('npm run build')
    expect(workflow).not.toContain('gh release')
  })
})
