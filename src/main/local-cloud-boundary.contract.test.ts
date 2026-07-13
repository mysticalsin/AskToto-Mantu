import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('local processing privacy boundary', () => {
  it('forces an opted-in vision request onto local before provider overrides or cloud routing', () => {
    const start = source.indexOf('const localVisionRequired =')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 800)
    expect(body).toMatch(/localVisionPrivacyRequired\(req, s\)/)
    expect(body).toMatch(/pickPrimaryProvider\([\s\S]*localVisionRequired[\s\S]*\)/)
  })

  it('reports a local screenshot readiness failure without claiming that cloud will handle it', () => {
    expect(source).toMatch(
      /localVisionRequired[\s\S]*Nothing was sent to a cloud provider/
    )
  })

  it('never sends a failed local request to a cloud failover provider', () => {
    const start = source.indexOf('onError: (message) => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 2_600)
    expect(body).toMatch(/provider !== 'local' && failover\(attempted\.concat\(provider\)\)/)
  })
})
