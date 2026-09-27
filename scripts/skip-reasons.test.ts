import { describe, expect, it } from 'vitest'
import { extractSkippedTests, reasonFor, REASONS } from './skip-reasons.mjs'

describe('extractSkippedTests', () => {
  it('returns exact skipped and pending assertion ids from a Vitest JSON report', () => {
    const report = {
      testResults: [
        {
          name: '/repo/scripts/alpha.test.ts',
          assertionResults: [
            { title: 'loads settings', status: 'passed' },
            { title: 'mac-only keychain path', status: 'pending' },
            { title: 'rejects bad settings', status: 'failed' }
          ]
        },
        {
          name: '/repo/src/beta.test.ts',
          assertionResults: [
            { title: 'renders report', status: 'passed' },
            { title: 'windows-only ACL path', status: 'skipped' }
          ]
        }
      ]
    }

    expect(extractSkippedTests(report)).toEqual([
      { id: 'scripts/alpha.test.ts :: mac-only keychain path', file: 'scripts/alpha.test.ts' },
      { id: 'src/beta.test.ts :: windows-only ACL path', file: 'src/beta.test.ts' }
    ])
  })
})

describe('reasonFor', () => {
  it('returns the declared reason text for an id containing a known match', () => {
    const reason = REASONS.find((entry) => entry.match === 'dustcli.test.ts')

    expect(reasonFor('scripts/dustcli.test.ts :: mac-only keychain path')).toBe(reason?.why)
  })

  it('returns null when no declared reason matches', () => {
    expect(reasonFor('scripts/unexplained.test.ts :: skipped without declaration')).toBeNull()
  })
})
