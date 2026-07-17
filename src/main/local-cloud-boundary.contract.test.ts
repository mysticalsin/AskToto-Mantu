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

  it('redacts the screen description before it crosses to a cloud provider (redactSensitive)', () => {
    // On macOS the pre-analyzed screen context can be a VERBATIM OCR extract (open password manager,
    // terminal with an API key). The injection into req.screenContext — which flows to whatever answer
    // provider is active, cloud included — must be built from the redacted local, never the raw field.
    const start = source.indexOf('if (req.wantsScreenContext) {')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('} catch (err) {', start)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toMatch(
      /const description = s\.redactSensitive \? redactSecrets\(ctx\.description\) : ctx\.description/
    )
    // From the assignment onward, only the redacted `description` local may be referenced — a future
    // edit reintroducing raw ctx.description into the assembled context must fail here.
    const assignIdx = body.indexOf('req.screenContext =')
    expect(assignIdx).toBeGreaterThan(-1)
    expect(body.slice(assignIdx)).not.toMatch(/ctx\.description/)
  })
})
