import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync: mocks.execSync }))

const EXIT = new Error('audit gate exit')

beforeEach(() => {
  vi.resetModules()
  mocks.execSync.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(() => { throw EXIT })
})
afterEach(() => vi.restoreAllMocks())

async function runGate(): Promise<void> {
  try {
    await import('./check-audit.mjs')
  } catch (error) {
    if (error !== EXIT) throw error
  }
}

async function runReport(report: unknown): Promise<void> {
  mocks.execSync.mockReturnValue(JSON.stringify(report))
  await runGate()
}

const cleanReport = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } }
})

describe('dependency audit gate report integrity', () => {
  it.each([
    { error: { code: 'ENOAUDIT', summary: 'private registry failure details' } },
    {},
    null,
    { ...cleanReport(), vulnerabilities: [] },
    { ...cleanReport(), vulnerabilities: { unknown: { severity: 'unexpected', nodes: [] } } },
    { ...cleanReport(), metadata: { vulnerabilities: { ...cleanReport().metadata.vulnerabilities, high: 1, total: 1 } } }
  ])('fails closed on an unverifiable scanner report %#', async (report) => {
    await runReport(report)
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[check:audit] OK'))
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('private registry'))
  })

  it('allows a complete clean npm report', async () => {
    await runReport(cleanReport())
    expect(process.exit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[check:audit] OK'))
  })

  it('still blocks a high advisory outside the existing narrow carve-out', async () => {
    const report = cleanReport()
    report.vulnerabilities = { risky: { severity: 'high', nodes: ['node_modules/risky'] } }
    report.metadata.vulnerabilities.high = 1
    report.metadata.vulnerabilities.total = 1
    await runReport(report)
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[check:audit] OK'))
  })

  it.each([
    'node_modules/@dust-tt/client/node_modules/runtime-package',
    'node_modules/@dust-tt/client/node_modules/ip-address-extra',
    'node_modules/@dust-tt/client/node_modules/ip-address/../../runtime-package',
    'node_modules/@dust-tt/client/node_modules/@modelcontextprotocol/sdk-extra',
    'node_modules/@dust-tt/client/dist/runtime.js'
  ])('never exempts a shipped or lookalike Dust path %s', async (node) => {
    const report = cleanReport()
    report.vulnerabilities = { affected: { severity: 'high', nodes: [node] } }
    report.metadata.vulnerabilities.high = 1
    report.metadata.vulnerabilities.total = 1
    await runReport(report)
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[check:audit] OK'))
  })

  it.each([
    '@modelcontextprotocol/sdk',
    'express-rate-limit',
    'ip-address',
    'ip-address/node_modules/nested'
  ])('preserves the documented pruned subtree %s', async (subtree) => {
    const report = cleanReport()
    report.vulnerabilities = { nested: { severity: 'high', nodes: [`node_modules/@dust-tt/client/node_modules/${subtree}`] } }
    report.metadata.vulnerabilities.high = 1
    report.metadata.vulnerabilities.total = 1
    await runReport(report)
    expect(process.exit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('excused 1'))
  })

  it('does not excuse an advisory with both pruned and shipped nodes', async () => {
    const report = cleanReport()
    report.vulnerabilities = { affected: { severity: 'critical', nodes: ['node_modules/@dust-tt/client/node_modules/ip-address', 'node_modules/ip-address'] } }
    report.metadata.vulnerabilities.critical = 1
    report.metadata.vulnerabilities.total = 1
    await runReport(report)
    expect(process.exit).toHaveBeenCalledWith(1)
  })

  it('accepts npm exit1 with a complete moderate-only report without broadening the high gate', async () => {
    const report = cleanReport()
    report.vulnerabilities = { affected: { severity: 'moderate', nodes: ['node_modules/affected'] } }
    report.metadata.vulnerabilities.moderate = 1
    report.metadata.vulnerabilities.total = 1
    mocks.execSync.mockImplementation(() => { throw Object.assign(new Error('vulnerabilities'), { status: 1, stdout: JSON.stringify(report) }) })
    await runGate()
    expect(process.exit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[check:audit] OK'))
  })

  it('fails closed on invalid JSON or a scanner process failure', async () => {
    mocks.execSync.mockReturnValue('not JSON')
    await runGate()
    expect(process.exit).toHaveBeenCalledWith(1)
    vi.resetModules()
    vi.mocked(process.exit).mockClear()
    mocks.execSync.mockImplementation(() => { throw Object.assign(new Error('private scanner failure'), { status: 2, stdout: JSON.stringify(cleanReport()) }) })
    await runGate()
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[check:audit] OK'))
  })
})
