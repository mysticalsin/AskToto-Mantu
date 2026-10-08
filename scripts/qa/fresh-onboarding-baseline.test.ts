import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runFreshOnboardingBaselineFlow } from './golden-flows/onboarding-flows.mjs'
import {
  ASSERTION_IDS,
  FRESH_ONBOARDING_SCHEMA,
  NOT_COVERED,
  assessFreshOnboardingReport,
  createLatchedActionCall,
  createFreshOnboardingReport,
  findFreshOnboardingPage,
  freshOnboardingIdentityFailure,
  identityBindingProblems,
  identityProblems,
  isStrictSemver,
  packagedAsarPath,
  readPackagedAsarVersion,
  reportProblems,
  teardownThenDispose,
  waitForProbe
} from './fresh-onboarding-baseline.mjs'

const IDENTITY = {
  candidate_run: 123,
  producer_commit: 'a'.repeat(40),
  installer_sha256: 'b'.repeat(64),
  version: '1.9.7',
  harness_commit: 'c'.repeat(40),
  platform: 'darwin'
} as const

const expected = {
  candidateRun: IDENTITY.candidate_run,
  commit: IDENTITY.producer_commit,
  sha256: IDENTITY.installer_sha256,
  version: IDENTITY.version,
  harnessCommit: IDENTITY.harness_commit,
  platform: IDENTITY.platform
} as const

function passingReport() {
  return createFreshOnboardingReport({
    outcome: 'PASS',
    identity: IDENTITY,
    assertions: ASSERTION_IDS.map((id) => ({ id, status: 'PASS' })),
    failure: 'none',
    teardown: 'ACKNOWLEDGED'
  })
}

describe('fresh onboarding baseline report', () => {
  it('keeps the report entirely finite and content-free', () => {
    const report = passingReport()
    expect(report.schema).toBe(FRESH_ONBOARDING_SCHEMA)
    expect(report.not_covered).toEqual(NOT_COVERED)
    expect(reportProblems(report)).toEqual([])
    expect(assessFreshOnboardingReport(report, expected)).toEqual({
      problems: [],
      notCovered: NOT_COVERED,
      row_verdicts: ASSERTION_IDS.map((id) => ({ id, status: 'PASS' }))
    })
  })

  it('accepts structurally valid failed and precondition reports without treating either as a pass', () => {
    const failed = passingReport()
    failed.outcome = 'FAIL'
    failed.failure = 'action-timeout'
    failed.assertions = failed.assertions.map((row) =>
      row.id === 'right-edge-persisted' ? { ...row, status: 'FAIL' } : row
    )

    expect(reportProblems(failed)).toEqual([])
    expect(assessFreshOnboardingReport(failed, expected, { requirePass: false }).problems).toEqual([])
    expect(assessFreshOnboardingReport(failed, expected).problems).toEqual(['OUTCOME_NOT_PASS'])

    const precondition = createFreshOnboardingReport({
      outcome: 'PRECONDITION',
      identity: {
        candidate_run: null,
        producer_commit: null,
        installer_sha256: null,
        version: null,
        harness_commit: IDENTITY.harness_commit,
        platform: IDENTITY.platform
      },
      failure: 'provenance-rejected',
      teardown: 'NOT_ATTEMPTED'
    })
    expect(reportProblems(precondition)).toEqual([])
    expect(assessFreshOnboardingReport(precondition, expected, { requirePass: false }).problems).toContain(
      'IDENTITY_CANDIDATE_RUN_MISMATCH'
    )
  })

  it.each([
    'cdp-attach-failed',
    'main-inspector-attach-failed',
    'profile-mismatch',
    'runtime-version-mismatch',
    'profile-and-runtime-version-mismatch'
  ])('retains the closed pre-UI failure %s without qualifying the flow', (failure) => {
    const report = createFreshOnboardingReport({
      outcome: 'FAIL',
      identity: IDENTITY,
      assertions: ASSERTION_IDS.map((id) => ({
        id,
        status: id === 'teardown-acknowledged' ? 'PASS' : 'NOT_RUN'
      })),
      failure,
      teardown: 'ACKNOWLEDGED'
    })
    expect(reportProblems(report)).toEqual([])
    expect(assessFreshOnboardingReport(report, expected, { requirePass: false }).problems).toEqual([])
    expect(assessFreshOnboardingReport(report, expected).problems).toEqual(['OUTCOME_NOT_PASS'])
    expect(reportProblems({ ...report, outcome: 'PASS' })).toContain('PASS_SEMANTICS_INVALID')
    expect(reportProblems({ ...report, outcome: 'PRECONDITION' })).toContain('PRECONDITION_SEMANTICS_INVALID')
    expect(reportProblems({ ...report, teardown: 'UNACKNOWLEDGED' })).toContain('TEARDOWN_ASSERTION_INVALID')
    const wrongHarness = { ...expected, harnessCommit: 'd'.repeat(40) }
    expect(assessFreshOnboardingReport(report, wrongHarness, { requirePass: false }).problems).toContain(
      'IDENTITY_HARNESS_COMMIT_MISMATCH'
    )
  })

  it('rejects arbitrary diagnostic text instead of extending the upload surface', () => {
    for (const failure of ['arbitrary diagnostic text', 'cdp-attach-failed\nextra', 'profile-home-mismatch']) {
      expect(reportProblems({ ...passingReport(), outcome: 'FAIL', failure })).toContain('REPORT_FAILURE_INVALID')
    }
  })

  it('rejects unknown report fields, reordered assertion rows and identity mismatches', () => {
    const unknown = { ...passingReport(), diagnostics: 'must-not-upload' }
    expect(reportProblems(unknown)).toContain('REPORT_KEYS_INVALID')

    const reordered = passingReport()
    reordered.assertions = [...reordered.assertions].reverse()
    expect(reportProblems(reordered)).toContain('ASSERTIONS_INVALID')

    const mismatch = passingReport()
    mismatch.identity = { ...mismatch.identity, version: '2.0.0' }
    expect(assessFreshOnboardingReport(mismatch, expected).problems).toContain('IDENTITY_VERSION_MISMATCH')
  })

  it('accepts only canonical identity values and canonical null slots', () => {
    expect(identityProblems(IDENTITY)).toEqual([])
    expect(identityProblems({ ...IDENTITY, producer_commit: 'A'.repeat(40) })).toContain(
      'IDENTITY_PRODUCER_COMMIT_INVALID'
    )
    expect(identityProblems({ ...IDENTITY, version: '1.9.7\nsecret' })).toContain('IDENTITY_VERSION_INVALID')
    expect(identityProblems({ ...IDENTITY, candidate_run: null })).toEqual([])
  })

  it('uses strict SemVer for provenance-bound identity, including prerelease components', () => {
    expect(isStrictSemver('1.2.3-rc.1+build.7')).toBe(true)
    for (const version of ['1.2.3-.', '1.2.3-a..b', '1.2.3-01', '01.2.3']) {
      expect(isStrictSemver(version)).toBe(false)
      expect(identityProblems({ ...IDENTITY, version })).toContain('IDENTITY_VERSION_INVALID')
    }
  })

  it('requires a complete identity before a launch can become candidate evidence', () => {
    expect(identityBindingProblems(IDENTITY)).toEqual([])
    expect(identityBindingProblems({ ...IDENTITY, candidate_run: null })).toEqual(['IDENTITY_INCOMPLETE'])
  })
})

describe('fresh onboarding runtime identity diagnostics', () => {
  it.each([
    { profileMatches: true, versionMatches: true, failure: 'none' },
    { profileMatches: false, versionMatches: true, failure: 'profile-mismatch' },
    { profileMatches: true, versionMatches: false, failure: 'runtime-version-mismatch' },
    { profileMatches: false, versionMatches: false, failure: 'profile-and-runtime-version-mismatch' }
  ])(
    'maps profile=$profileMatches version=$versionMatches to $failure',
    ({ profileMatches, versionMatches, failure }) => {
      expect(freshOnboardingIdentityFailure(profileMatches, versionMatches)).toBe(failure)
    }
  )
})

describe('fresh onboarding archive identity', () => {
  const target = { installRoot: '/Applications/Metis.app', executable: '/Applications/Metis.app/Contents/MacOS/Metis' }

  it('uses the packaged archive version rather than a platform resource version', async () => {
    const archive = packagedAsarPath(target, 'darwin')
    expect(archive).toBe('/Applications/Metis.app/Contents/Resources/app.asar')
    expect(
      packagedAsarPath(
        { installRoot: 'C:\\Program Files\\Metis', executable: 'C:\\Program Files\\Metis\\Metis.exe' },
        'win32'
      )
    ).toBe('C:\\Program Files\\Metis\\resources\\app.asar')
    await expect(
      readPackagedAsarVersion({
        target,
        platform: 'darwin',
        lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
        loadAsar: async () => ({ extractFile: (path: string, entry: string) => Buffer.from('{"version":"1.9.7"}') })
      })
    ).resolves.toBe('1.9.7')
  })

  it('rejects a missing, linked, or malformed archive before launch', async () => {
    await expect(
      readPackagedAsarVersion({
        target,
        platform: 'darwin',
        lstat: () => {
          throw new Error('missing')
        }
      })
    ).rejects.toThrow('packaged app archive is missing')

    await expect(
      readPackagedAsarVersion({
        target,
        platform: 'darwin',
        lstat: () => ({ isFile: () => true, isSymbolicLink: () => true, size: 1 })
      })
    ).rejects.toThrow('regular non-empty')

    await expect(
      readPackagedAsarVersion({
        target,
        platform: 'darwin',
        lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
        loadAsar: async () => ({ extractFile: () => Buffer.from('{"version":"1.2.3-01"}') })
      })
    ).rejects.toThrow('packaged package.json version is invalid')
  })
})

describe('fresh onboarding baseline bounded actions', () => {
  it('latches a timed-out action before a later action can begin', async () => {
    const calls: string[] = []
    const call = createLatchedActionCall(async (operation: () => Promise<unknown>) => {
      calls.push('bound')
      await operation()
      throw new Error('fresh-action-timeout')
    }, 1)

    await expect(
      call(async () => {
        calls.push('first')
      })
    ).rejects.toMatchObject({ failure: 'action-timeout' })

    let laterActionStarted = false
    await expect(
      call(async () => {
        laterActionStarted = true
      })
    ).rejects.toMatchObject({ failure: 'action-timeout' })

    expect(calls).toEqual(['bound', 'first'])
    expect(laterActionStarted).toBe(false)
  })

  it('selects only a page with both the onboarding stage and the settings bridge', async () => {
    const calls: string[] = []
    const foreign = {
      isClosed: () => false,
      evaluate: async () => {
        calls.push('foreign')
        return false
      }
    }
    const onboarding = {
      isClosed: () => false,
      evaluate: async () => {
        calls.push('onboarding')
        return true
      }
    }
    const browser = { contexts: () => [{ pages: () => [foreign, onboarding] }] }
    const found = await findFreshOnboardingPage({
      browser,
      call: async (operation: () => Promise<unknown>) => operation(),
      timeoutMs: 100,
      verifyLaunch: () => calls.push('launch')
    })
    expect(found).toBe(onboarding)
    expect(calls).toEqual(['launch', 'foreign', 'launch', 'onboarding', 'launch'])
  })

  it('does not accept a fresh-profile probe that becomes true after its monotonic deadline', async () => {
    const readings = [0, 0, 11]
    const budgets: number[] = []
    const result = await waitForProbe(
      async (remaining: number) => {
        budgets.push(remaining)
        return true
      },
      10,
      () => readings.shift() ?? 11
    )
    expect(result).toBe(false)
    expect(budgets).toEqual([10])
  })

  it('does not evaluate a later renderer page after the bounded page probe times out', async () => {
    let laterPageEvaluated = false
    const first = { isClosed: () => false, evaluate: async () => false }
    const later = {
      isClosed: () => false,
      evaluate: async () => {
        laterPageEvaluated = true
        return true
      }
    }
    const browser = { contexts: () => [{ pages: () => [first, later] }] }
    const timeout = Object.assign(new Error('fresh-action-timeout'), { failure: 'action-timeout' })
    await expect(
      findFreshOnboardingPage({
        browser,
        call: async (operation: () => Promise<unknown>) => {
          await operation()
          throw timeout
        },
        timeoutMs: 100,
        verifyLaunch: () => {}
      })
    ).rejects.toMatchObject({ failure: 'action-timeout' })
    expect(laterPageEvaluated).toBe(false)
  })
})

describe('fresh onboarding baseline teardown order', () => {
  it('stops the owned child before releasing transport', async () => {
    const calls: string[] = []
    const result = await teardownThenDispose({
      child: { pid: 42 },
      stop: async () => {
        calls.push('stop')
        return { state: 'acknowledged' }
      },
      normalize: (value) => value,
      dispose: async () => {
        calls.push('dispose')
        return true
      }
    })

    expect(calls).toEqual(['stop', 'dispose'])
    expect(result).toEqual({ teardown: 'ACKNOWLEDGED', transportReleased: true })
  })

  it('does not release transport or delete state after an unacknowledged stop', async () => {
    const dispose = async () => {
      throw new Error('must not run')
    }
    const result = await teardownThenDispose({
      child: { pid: 42 },
      stop: async () => ({ state: 'unacknowledged', reason: 'group-still-present' }),
      normalize: (value) => value,
      dispose
    })
    expect(result).toEqual({ teardown: 'UNACKNOWLEDGED', transportReleased: false })
  })

  it('fails closed when launch was attempted but no exact child receipt was captured', async () => {
    let stopCalled = false
    let transportReleased = false
    const result = await teardownThenDispose({
      child: null,
      stop: async () => {
        stopCalled = true
        return { state: 'acknowledged' }
      },
      normalize: (value) => value,
      dispose: async () => {
        transportReleased = true
        return true
      }
    })

    expect(result).toEqual({ teardown: 'UNACKNOWLEDGED', transportReleased: false })
    expect(stopCalled).toBe(false)
    expect(transportReleased).toBe(false)
  })
})

describe('fresh onboarding baseline flow', () => {
  it('does not accept an appearance condition that settles after the flow deadline', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(11)
    try {
      type FakeStage = {
        first: () => FakeStage
        waitFor: () => Promise<void>
        evaluate: () => Promise<boolean>
      }
      const stage: FakeStage = {
        first: () => stage,
        waitFor: async () => undefined,
        evaluate: async () => true
      }
      const marked: Array<[string, string]> = []
      await expect(
        runFreshOnboardingBaselineFlow({
          win: { locator: () => stage },
          timeoutMs: 10,
          call: async (operation: () => Promise<unknown>) => operation(),
          nativeFullDisplay: async () => true,
          mark: (id: string, status: string) => marked.push([id, status])
        })
      ).rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
      expect(marked).toEqual([['opaque-full-display', 'FAIL']])
    } finally {
      now.mockRestore()
    }
  })

  it('uses only the explicit hero, problem, reveal, and placement route before Setup', async () => {
    const actions: string[] = []
    const marked: Array<[string, string]> = []
    let appearanceVisible = true
    let finalOnboardingActive = true
    let settingsReads = 0
    type FakeButton = {
      waitFor: () => Promise<number>
      click: () => Promise<number>
      last: () => FakeButton
    }
    type FakeLocator = {
      first: () => FakeLocator
      waitFor: () => Promise<number>
      evaluate?: () => Promise<boolean>
    }
    const namedButton = (name: string): FakeButton => {
      const button: FakeButton = {
        waitFor: async () => actions.push(`wait:${name}`),
        click: async () => actions.push(`click:${name}`),
        last: () => button
      }
      return button
    }
    const locator = (label: string, includeEvaluate = false): FakeLocator => {
      const item: FakeLocator = {
        first: () => item,
        waitFor: async () => actions.push(`wait:${label}`)
      }
      if (includeEvaluate) {
        item.evaluate = async () => {
          actions.push(`evaluate:${label}`)
          return label === 'appearance' ? appearanceVisible && finalOnboardingActive : true
        }
      }
      return item
    }
    const stage = locator('stage', true)
    const position = locator('position')
    const appearance = locator('appearance', true)
    const rightEdge = { click: async () => actions.push('click:right-edge') }
    const radios = {
      evaluateAll: async () => 0,
      nth: () => rightEdge
    }
    const win = {
      locator: (selector: string) => {
        if (selector === '.onboard-stage') return stage
        if (selector === 'button[role="radio"]') return radios
        if (selector === '[data-onboard-appearance-step="position"]') return position
        if (selector === '[data-onboard-appearance-step="appearance"]') return appearance
        throw new Error(`unexpected selector ${selector}`)
      },
      getByRole: (role: string, options: { name: string | RegExp }) => {
        if (role === 'button' && typeof options.name === 'string') return namedButton(options.name)
        if (role === 'radio') {
          return {
            count: async () => {
              actions.push('count:bar')
              return 0
            }
          }
        }
        throw new Error(`unexpected role ${role}`)
      },
      evaluate: async () => {
        actions.push('evaluate:settings')
        settingsReads += 1
        return settingsReads === 1
      }
    }

    const runFlow = () =>
      runFreshOnboardingBaselineFlow({
        win,
        timeoutMs: 1_000,
        call: async (operation: () => Promise<unknown>) => operation(),
        nativeFullDisplay: async () => true,
        mark: (id: string, status: string) => marked.push([id, status])
      })

    await runFlow()

    expect(actions.filter((action) => action.startsWith('click:'))).toEqual([
      'click:Next',
      'click:Continue',
      'click:Set me up',
      'click:right-edge',
      'click:Continue to appearance'
    ])
    expect(marked).toEqual([
      ['opaque-full-display', 'PASS'],
      ['native-display-bounds', 'PASS'],
      ['right-edge-visible', 'PASS'],
      ['right-edge-persisted', 'PASS'],
      ['bar-absent', 'PASS'],
      ['placement-to-appearance', 'PASS'],
      ['pre-setup-boundary', 'PASS']
    ])
    expect(actions.indexOf('count:bar')).toBeGreaterThan(actions.indexOf('wait:appearance'))
    expect(actions.indexOf('evaluate:appearance')).toBeGreaterThan(actions.indexOf('wait:appearance'))

    appearanceVisible = false
    settingsReads = 0
    await expect(runFlow()).rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
    expect(marked[marked.length - 1]).toEqual(['pre-setup-boundary', 'FAIL'])

    appearanceVisible = true
    finalOnboardingActive = false
    settingsReads = 0
    await expect(runFlow()).rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
    expect(marked[marked.length - 1]).toEqual(['pre-setup-boundary', 'FAIL'])
  })
})

describe('fresh onboarding baseline import safety', () => {
  it('keeps Playwright and the app/flow drivers out of the candidate-guard import graph', () => {
    const source = readFileSync(new URL('./fresh-onboarding-baseline.mjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^import .*playwright/m)
    expect(source).not.toMatch(/^import .*app-driver/m)
    expect(source).not.toMatch(/^import .*onboarding-flows/m)
  })

  it('keeps the fresh flow pre-Setup, no-capture, and awaits the persisted setting read', () => {
    const source = readFileSync(new URL('./golden-flows/onboarding-flows.mjs', import.meta.url), 'utf8')
    const flow = source.slice(source.indexOf('export async function runFreshOnboardingBaselineFlow'))
    expect(flow).toContain('const settings = await window.toto.getSettings()')
    expect(flow).toContain("name: 'Next', exact: true")
    expect(flow).toContain("name: 'Continue', exact: true")
    expect(flow).toContain("name: 'Set me up', exact: true")
    expect(flow).toContain('[data-onboard-appearance-step="position"]')
    expect(flow).toContain('[data-onboard-appearance-step="appearance"]')
    expect(flow).toContain('const stillAtAppearanceBeforeSetup')
    expect(flow).toContain('settings.onboardingDone === false')
    expect(flow).not.toContain('screenshot(')
    expect(flow).not.toContain('finishOnboarding')
    expect(flow).not.toContain('setSettings(')
    expect(flow).not.toContain('requestPermissions')
  })

  it('records a launch attempt before awaiting the app and preserves its failure through unacknowledged teardown', () => {
    const source = readFileSync(new URL('./fresh-onboarding-baseline.mjs', import.meta.url), 'utf8')
    expect(source.indexOf('state.launchAttempted = true')).toBeLessThan(source.indexOf('launch = launchPackagedCdp'))
    expect(source.indexOf('stopOwnedChild')).toBeLessThan(source.indexOf('disposeFreshOnboardingTransports'))

    const report = createFreshOnboardingReport({
      outcome: 'FAIL',
      identity: IDENTITY,
      assertions: ASSERTION_IDS.map((id) => ({
        id,
        status: id === 'teardown-acknowledged' ? 'FAIL' : 'NOT_RUN'
      })),
      failure: 'launch-failed',
      teardown: 'UNACKNOWLEDGED'
    })
    expect(reportProblems(report)).toEqual([])
    expect(report.failure).toBe('launch-failed')
    expect(report.teardown).toBe('UNACKNOWLEDGED')
  })
})
