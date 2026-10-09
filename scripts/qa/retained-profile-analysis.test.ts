import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SOURCES,
  checkoutReceipt,
  closedFailure,
  decodeJson,
  getBytes,
  manifestNames,
  nativeCanary,
  runUnzip,
  selectedSizes,
  summarizeProfile,
  summarizeReport,
  validateSummary,
  verifyArchiveBytes,
  verifyArtifact,
  verifyJob,
  verifyProvenance,
  verifyRun
} from './retained-profile-analysis.mjs'

const source = SOURCES[0]
const now = () => performance.now()
const budget = () => now() + 120_000
const ack = { state: 'acknowledged' }
const secret = 'SYNTHETIC_PRIVATE_VALUE_must_not_be_emitted'
const hostedCi = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'

function report() {
  return {
    harness: 'ST-1',
    row: 'fifo',
    platform: 'darwin',
    arch: 'arm64',
    historyRow: true,
    historyMode: 'on',
    build_run_id: source.run,
    artifact_sha256: source.qaSha,
    installer: 'Metis-QA-1.9.7.zip',
    complete: true,
    verdict: 'FAIL',
    teardown: { state: 'acknowledged' },
    samples: 1,
    lateSamples: 1,
    cpuProfile: {
      requestedAtMs: 100,
      answeredAtMs: 110,
      startedAtMs: 110,
      stoppedAtMs: 1000,
      running: false,
      file: 'st-1-macos-fifo-history.cpuprofile'
    },
    loop: { maxMs: 500, p99Ms: 20 },
    write: { maxMs: 10 },
    lookup: { maxMs: 3 },
    history: [{ tMs: 20_000 }],
    timeline: [
      {
        tMs: 111,
        answeredMs: 1100,
        late: true,
        writeMs: 1001,
        lookupMs: 30,
        runLoopMaxMs: 500,
        loopMaxDuringWriteMs: 400,
        loopMaxSinceLastMs: 500
      },
      {
        tMs: 2211,
        answeredMs: 20,
        writeMs: 10,
        lookupMs: 3,
        runLoopMaxMs: 500,
        loopMaxDuringWriteMs: 1,
        loopMaxSinceLastMs: 2
      }
    ]
  }
}

function profile() {
  const frame = (functionName: string) => ({
    functionName,
    url: secret,
    lineNumber: -1,
    columnNumber: -1,
    scriptId: '0'
  })
  return {
    startTime: 1000,
    endTime: 901_000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 5] },
      { id: 2, callFrame: frame('withBootFirstShowDeferred'), children: [3] },
      { id: 3, callFrame: frame('createWindow'), children: [4] },
      { id: 4, callFrame: frame('View') },
      { id: 5, callFrame: frame('(idle)') }
    ],
    samples: [4, 5, 4],
    timeDeltas: [100_000, 500_000, 200_000]
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('fixed retained source custody', () => {
  it('pins two different PR heads, merge checkouts, archives and QA hashes', () => {
    expect(SOURCES.map((s) => s.run)).toEqual([37759977579, 37780722264])
    for (const s of SOURCES) {
      expect(s.head).not.toBe(s.commit)
      expect(s.history.sha).toMatch(/^[a-f0-9]{64}$/)
      expect(s.provenance.sha).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('requires the exact same-repository PR run, workflow, attempt and completed state', () => {
    const data = {
      id: source.run,
      path: '.github/workflows/qa-candidate.yml',
      event: 'pull_request',
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      head_sha: source.head,
      repository: { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' },
      head_repository: { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' }
    }
    expect(() => verifyRun(data, source)).not.toThrow()
    for (const field of ['id', 'path', 'event', 'run_attempt', 'status', 'conclusion', 'head_sha']) {
      expect(() => verifyRun({ ...data, [field]: secret }, source)).toThrow()
    }
    expect(() => verifyRun({ ...data, head_repository: { ...data.head_repository, id: 1 } }, source)).toThrow()
  })

  it('binds artifact ID, name, size, digest and run, and rejects expiration', () => {
    const a = source.history
    const data = {
      id: a.id,
      name: a.name,
      size_in_bytes: a.size,
      digest: `sha256:${a.sha}`,
      expired: false,
      workflow_run: {
        id: source.run,
        repository_id: 1282463398,
        head_repository_id: 1282463398,
        head_sha: source.head
      }
    }
    expect(() => verifyArtifact(data, a, source)).not.toThrow()
    for (const field of ['id', 'name', 'size_in_bytes', 'digest', 'expired', 'workflow_run']) {
      expect(() => verifyArtifact({ ...data, [field]: secret }, a, source)).toThrow()
    }
    expect(() => verifyArtifact({ ...data, expired: true }, a, source)).toThrow()
  })

  it('requires both job identity and one actual checkout receipt rather than API head_sha', () => {
    const job = {
      id: source.historyJob,
      name: 'ST-1 History row (macOS)',
      run_id: source.run,
      head_sha: source.head,
      status: 'completed',
      conclusion: 'success'
    }
    expect(() => verifyJob(job, source.historyJob, job.name, source)).not.toThrow()
    expect(() => verifyJob({ ...job, head_sha: source.commit }, job.id, job.name, source)).toThrow()
    const log = `2026-10-08T00:00:00Z [command]/opt/homebrew/bin/git log -1 --format=%H\n2026-10-08T00:00:00Z ${source.commit}\n`
    expect(checkoutReceipt(log, source)).toBe(source.commit)
    expect(() => checkoutReceipt(log + log, source)).toThrow()
    expect(() => checkoutReceipt(log.replace(source.commit, source.head), source)).toThrow()
    expect(() => checkoutReceipt(secret, source)).toThrow()
  })

  it('binds historical provenance without downloading installer bytes', () => {
    const provenance = {
      schema: 1,
      repository: 'mysticalsin/AskToto-Mantu',
      run: { id: source.run },
      commit: source.commit,
      version: '1.9.7',
      builds: [
        {
          variant: 'mac-qa-identity',
          assets: [{ name: 'Metis-QA-1.9.7.zip', sha256: source.qaSha, size: 100 }]
        }
      ]
    }
    expect(() => verifyProvenance(provenance, source)).not.toThrow()
    expect(() => verifyProvenance(provenance, SOURCES[1])).toThrow()
    expect(() => verifyProvenance({ ...provenance, commit: source.head }, source)).toThrow()
    expect(() =>
      verifyProvenance({ ...provenance, builds: [...provenance.builds, ...provenance.builds] }, source)
    ).toThrow()
  })

  it('checks full archive bytes against size and digest before native parsing', () => {
    const expected = { size: 0, sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
    expect(() => verifyArchiveBytes(Buffer.alloc(0), expected)).not.toThrow()
    expect(() => verifyArchiveBytes(Buffer.from(secret), expected)).toThrow('archive-mismatch')
    expect(() => verifyArchiveBytes(Buffer.alloc(0), { ...expected, sha: source.history.sha })).toThrow()
  })
})

describe('selected ZIP members and data boundaries', () => {
  it('accepts a unique bounded manifest and selects only literal root names', () => {
    expect(manifestNames('a.json\nignored/log.txt\n', ['a.json'])).toEqual(['a.json', 'ignored/log.txt'])
  })

  it.each([
    '../a.json\n',
    '/a.json\n',
    'C:/a.json\n',
    'a\\b\n',
    'a/./b\n',
    'a//b\n',
    'a.json\na.json\n',
    'a.json\nA.JSON\n',
    'a.json\nprivate name\n',
    'a.json\n\n',
    'a.json\n\u0000bad\n'
  ])('rejects ambiguous manifest %j', (text) => {
    expect(() => manifestNames(text, ['a.json'])).toThrow()
  })

  it('rejects missing or excessive members without extracting them', () => {
    expect(() => manifestNames('b.json\n', ['a.json'])).toThrow()
    const excessive = Array.from({ length: 33 }, (_, i) => `${i}.json`).join('\n') + '\n'
    expect(() => manifestNames(excessive, ['0.json'])).toThrow()
  })

  it('reads bounded unx/fat regular stored/deflate member metadata', () => {
    const rows =
      '-rw-r--r--  2.0 unx 11 b- 11 stor 80-Jan-01 00:00 a.json\n' +
      '--rw-a-- 2.0 fat 12 bl 8 defN 80-Jan-01 00:00 b.json\n'
    expect(selectedSizes(rows, { 'a.json': 20, 'b.json': 20 })).toEqual({ 'a.json': 11, 'b.json': 12 })
  })

  it.each(['lrwxrwxrwx', 'crw-r--r--', 'prw-r--r--'])('rejects selected nonregular mode %s', (mode) => {
    expect(() => selectedSizes(`${mode} 2.0 unx 11 b- 11 stor 80-Jan-01 00:00 a.json\n`, { 'a.json': 20 })).toThrow()
  })

  it('rejects encrypted, oversize, duplicate and unexpected metadata', () => {
    const row = '-rw-r--r-- 2.0 unx 11 b- 11 stor 80-Jan-01 00:00 a.json\n'
    expect(() => selectedSizes(row.replace('b-', 'B-'), { 'a.json': 20 })).toThrow()
    expect(() => selectedSizes(row, { 'a.json': 10 })).toThrow()
    expect(() => selectedSizes(row + row, { 'a.json': 20 })).toThrow()
    expect(() => selectedSizes(row + secret, { 'a.json': 20 })).toThrow()
    expect(() => selectedSizes('Archive: unexpected\n' + row, { 'a.json': 20 })).toThrow()
  })

  it('rejects invalid UTF-8, malformed JSON and the byte limit without echoing bytes', () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from(secret), Buffer.from('{}')]) {
      expect(() => decodeJson(bytes, 1)).toThrow()
    }
    expect(decodeJson(Buffer.from('{}'), 2)).toEqual({})
    expect(closedFailure(new Error(secret))).toBe('analysis-failed')
  })
})

describe('historical measurement semantics', () => {
  it('recomputes inclusive and timely maxima without rewriting FAIL', () => {
    const result = summarizeReport(report(), source)
    expect(result.originalVerdict).toBe('FAIL')
    expect(result.timelyWriteMaxMs).toBe(10)
    expect(result.allWriteMaxMs).toBe(1001)
    expect(result.firstLate.tMs).toBe(111)
    expect(result.firstHistoryMs).toBe(20_000)
  })

  it('checks inclusive summary only for the newer source and binds the pair', () => {
    const newer = {
      ...report(),
      build_run_id: SOURCES[1].run,
      artifact_sha256: SOURCES[1].qaSha,
      allResponseIo: {
        write: { maxMs: 1001, observedSamples: 2 },
        lookup: { maxMs: 30, observedSamples: 2 }
      }
    }
    expect(() => summarizeReport(newer, SOURCES[1])).not.toThrow()
    expect(() => summarizeReport(newer, source)).toThrow()
    expect(() =>
      summarizeReport({ ...newer, allResponseIo: { write: { maxMs: 10, observedSamples: 1 } } }, SOURCES[1])
    ).toThrow()
    expect(() => summarizeReport({ ...report(), write: { maxMs: 1001 } }, source)).toThrow()
  })

  it('keeps hung values unknown and rejects unacknowledged/incomplete source', () => {
    const data = report()
    data.timeline.push({ tMs: 3000, late: true, hung: true } as never)
    data.lateSamples = 2
    expect(summarizeReport(data, source).allWriteCount).toBe(2)
    expect(() => summarizeReport({ ...data, complete: false }, source)).toThrow()
    expect(() => summarizeReport({ ...data, teardown: { state: 'unacknowledged' } }, source)).toThrow()
  })

  it.each([-1, Infinity, NaN])('rejects invalid observed duration %s', (value) => {
    const data = report()
    data.timeline[0].writeMs = value
    expect(() => summarizeReport(data, source)).toThrow()
  })

  it('uses closed categories, preserves mass and reports clock uncertainty', () => {
    const result = summarizeProfile(profile(), report().cpuProfile, summarizeReport(report(), source))
    expect(result.categories.find((r) => r.category === 'window-create-view')).toMatchObject({
      samples: 2,
      deltaUs: 300_000,
      firstOffsetUs: 100_000,
      lastOffsetUs: 800_000,
      firstAppIntervalMs: [200, 210],
      lastAppIntervalMs: [900, 910]
    })
    expect(result.categories.reduce((sum, row) => sum + row.deltaUs, 0)).toBe(800_000)
    expect(result.categories.reduce((sum, row) => sum + row.samples, 0)).toBe(3)
    expect(result.residualUs).toBe(100_000)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.bins[1].reduce((sum, item) => sum + item[1], 0)).toBe(700_000)
    expect(result.firstLateOverlap?.intervalMs).toEqual([111, 1211])
    expect(result.firstLateOverlap?.categories[3]).toEqual([2, 300_000])
    expect(result.peakReceiptOverlap?.categories[0]).toEqual([1, 500_000])
  })

  it('rejects duplicate nodes, cycles, multiple parents, missing samples and chronology errors', () => {
    const cases = [
      (p: ReturnType<typeof profile>) => p.nodes.push(p.nodes[0]),
      (p: ReturnType<typeof profile>) => {
        p.nodes[3].children = [1]
      },
      (p: ReturnType<typeof profile>) => {
        p.nodes[4].children = [4]
      },
      (p: ReturnType<typeof profile>) => {
        p.samples[0] = 999
      },
      (p: ReturnType<typeof profile>) => {
        p.timeDeltas.pop()
      },
      (p: ReturnType<typeof profile>) => {
        p.timeDeltas[0] = -1
      },
      (p: ReturnType<typeof profile>) => {
        p.endTime = 0
      }
    ]
    for (const change of cases) {
      const data = profile()
      change(data)
      expect(() => summarizeProfile(data, report().cpuProfile)).toThrow()
    }
  })

  it('rejects unexpected fields and non-enumerated strings in public summary', () => {
    expect(() => validateSummary({ secret, sources: [] })).toThrow()
    expect(() => validateSummary({ schema: 1, sources: [], causalConclusion: secret })).toThrow()
  })

  it('rejects unordered History probes and preserves unknown overlap for missing receipts', () => {
    expect(() => summarizeReport({ ...report(), history: [{ tMs: 2 }, { tMs: 1 }] }, source)).toThrow()
    const result = summarizeProfile(profile(), report().cpuProfile)
    expect(result.firstLateOverlap).toBeNull()
    expect(result.peakReceiptOverlap).toBeNull()
  })

  it('keeps unknown/private symbols in other and rejects depth and sample bounds', () => {
    const data = profile()
    data.nodes[3].callFrame.functionName = secret
    expect(summarizeProfile(data, report().cpuProfile).categories[8].samples).toBe(2)
    data.samples = Array(100_001).fill(4)
    expect(() => summarizeProfile(data, report().cpuProfile)).toThrow()
    const deep = profile()
    deep.nodes = Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      callFrame: { ...deep.nodes[0].callFrame, functionName: index === 0 ? '(root)' : secret },
      children: index === 129 ? [] : [index + 2]
    }))
    expect(() => summarizeProfile(deep, report().cpuProfile)).toThrow()
  })

  it('round-trips only the complete closed public schema', () => {
    const summarized = summarizeReport(report(), source)
    const value = {
      schema: 1,
      causalConclusion: 'not-established',
      preProfileCause: 'unknown',
      instrumentation: 'startup-and-profiler-included',
      binConvention: 'sample-endpoint',
      applicationRerun: false,
      st1Evidence: false,
      promotable: false,
      sources: SOURCES.map((s) => ({
        run: s.run,
        harnessCommit: s.commit,
        historyArtifact: s.history.id,
        provenanceArtifact: s.provenance.id,
        historyArchiveSha256: s.history.sha,
        provenanceArchiveSha256: s.provenance.sha,
        qaSha256: s.qaSha,
        binding: 'historical-provenance-report-only',
        members: { report: s.qaSha, profile: s.qaSha, provenance: s.qaSha },
        report: summarized,
        profile: summarizeProfile(profile(), report().cpuProfile, summarized)
      }))
    }
    const encoded = JSON.stringify(value)
    expect(encoded.length).toBeLessThan(64 * 1024)
    expect(encoded).not.toContain(secret)
    expect(validateSummary(JSON.parse(encoded))).toEqual(value)
    expect(() => validateSummary({ ...value, privateText: secret })).toThrow()
    expect(() => validateSummary({ ...value, promotable: true })).toThrow()
    value.sources[0].profile.categories[0].category = secret
    expect(() => validateSummary(value)).toThrow()
  })
})

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new EventEmitter()
  })
  return child
}

describe('bounded owned native capture', () => {
  it('uses the exact executable, literal arguments and credential-free environment; requires cleanup ACK', async () => {
    const child = childFixture()
    const spawnFn = vi.fn(() => child)
    const stop = vi.fn(async () => ack)
    const pending = runUnzip(['-v'], { cwd: '/tmp/synthetic', cap: 20, deadline: budget(), spawnFn, stop })
    child.stdout.emit('data', Buffer.from('safe'))
    child.exitCode = 0
    child.emit('close', 0, null)
    await expect(pending).resolves.toEqual(Buffer.from('safe'))
    expect(spawnFn.mock.calls[0]).toMatchObject([
      '/usr/bin/unzip',
      ['-v'],
      {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }
      }
    ])
    expect(stop).toHaveBeenCalledOnce()
    expect(child.listenerCount('close')).toBe(0)
  })

  it('discards overflow and will not acknowledge a surviving group', async () => {
    const child = childFixture()
    const stop = vi.fn(async () => ({ state: 'unacknowledged', reason: 'group-still-present' }))
    const pending = runUnzip(['-v'], {
      cwd: '/tmp/synthetic',
      cap: 1,
      deadline: budget(),
      spawnFn: () => child,
      stop
    })
    child.stdout.emit('data', Buffer.from(secret))
    child.exitCode = 0
    child.emit('close', 0, null)
    await expect(pending).rejects.toThrow('native-unacknowledged')
  })

  it('has one bounded deadline even when no native output arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const child = childFixture()
    const stop = vi.fn(async () => {
      child.signalCode = 'SIGKILL'
      child.emit('close', null, 'SIGKILL')
      return ack
    })
    const pending = runUnzip(['-v'], {
      cwd: '/tmp/synthetic',
      cap: 20,
      deadline: 120_000,
      now: () => Date.now(),
      spawnFn: () => child,
      stop
    })
    const rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [1, null],
    [null, 'SIGTERM']
  ])('rejects native exit %s / signal %s after acknowledged cleanup', async (code, signal) => {
    const child = childFixture()
    const pending = runUnzip(['-v'], {
      cwd: '/tmp/synthetic',
      cap: 20,
      deadline: budget(),
      spawnFn: () => child,
      stop: async () => ack
    })
    child.emit('close', code, signal)
    await expect(pending).rejects.toThrow('native-failed')
  })

  it('latches an error arriving during cleanup and disposes stream listeners', async () => {
    const child = childFixture()
    const pending = runUnzip(['-v'], {
      cwd: '/tmp/synthetic',
      cap: 20,
      deadline: budget(),
      spawnFn: () => child,
      stop: async () => {
        child.emit('error', new Error(secret))
        return ack
      }
    })
    child.emit('close', 0, null)
    await expect(pending).rejects.toThrow('native-failed')
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
  })

  it('silences late child and pipe errors after uncertain cleanup until terminal close', async () => {
    const child = childFixture()
    const pending = runUnzip(['-v'], {
      cwd: '/tmp/synthetic',
      cap: 1,
      deadline: budget(),
      spawnFn: () => child,
      stop: async () => ({ state: 'unacknowledged', reason: 'group-still-present' })
    })
    child.stdout.emit('data', Buffer.from(secret))
    await expect(pending).rejects.toThrow('native-unacknowledged')
    expect(() => child.emit('error', new Error(secret))).not.toThrow()
    expect(() => child.stdout.emit('error', new Error(secret))).not.toThrow()
    expect(child.listenerCount('error')).toBe(1)
    expect(child.stdout.listenerCount('error')).toBe(1)
    child.emit('close', null, 'SIGKILL')
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stdout.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('rejects an unclosed pipe even if process cleanup reports ACK', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const child = childFixture()
    const pending = runUnzip(['-v'], {
      cwd: '/tmp/synthetic',
      cap: 1,
      deadline: 120_000,
      now: () => Date.now(),
      spawnFn: () => child,
      stop: async () => ack
    })
    const rejection = expect(pending).rejects.toThrow('native-unacknowledged')
    child.stdout.emit('data', Buffer.from(secret))
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not spawn into the cleanup reserve or expose spawn exceptions', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error(secret)
    })
    await expect(runUnzip(['-v'], { cap: 20, deadline: 10_000, now: () => 0, spawnFn })).rejects.toThrow('deadline')
    expect(spawnFn).not.toHaveBeenCalled()
    await expect(runUnzip(['-v'], { cap: 20, deadline: budget(), spawnFn })).rejects.toThrow('native-failed')
  })
})

describe('bounded GitHub transport', () => {
  it('strips authorization for the one signed redirect and bounds bytes', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.invalid/signed?opaque=secret' } })
      )
      .mockResolvedValueOnce(new Response('ok'))
    await expect(
      getBytes(`artifacts/${source.history.id}/zip`, { cap: 2, deadline: budget(), token: secret, fetchFn })
    ).resolves.toEqual(Buffer.from('ok'))
    expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${secret}`)
    expect(new Headers(fetchFn.mock.calls[1][1]?.headers).get('authorization')).toBeNull()
    expect(fetchFn.mock.calls[1][1]?.redirect).toBe('manual')
  })

  it.each([
    'http://example.invalid/x',
    'https://user@example.invalid/x',
    'https://example.invalid:444/x',
    'https://example.invalid/x#fragment'
  ])('rejects unsafe signed redirect %s', async (location) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
    await expect(
      getBytes(`artifacts/${source.history.id}/zip`, { cap: 2, deadline: budget(), token: secret, fetchFn })
    ).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('rejects second redirects, excess output and arbitrary API routes', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(secret))
    await expect(getBytes('runs/1', { cap: 1, deadline: budget(), token: secret, fetchFn })).rejects.toThrow()
    await expect(getBytes('../secrets', { cap: 1, deadline: budget(), token: secret, fetchFn })).rejects.toThrow()
    await expect(getBytes('artifacts/1/zip', { cap: 1, deadline: budget(), token: secret, fetchFn })).rejects.toThrow(
      'redirect-invalid'
    )
    const redirect = vi
      .fn()
      .mockImplementation(
        async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/again' } })
      )
    await expect(
      getBytes(`artifacts/${source.history.id}/zip`, {
        cap: 2,
        deadline: budget(),
        token: secret,
        fetchFn: redirect
      })
    ).rejects.toThrow()
    expect(redirect).toHaveBeenCalledTimes(2)
  })

  it('aborts a stalled reader and cancels it without leaving timers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response)
    const pending = getBytes('runs/1', {
      cap: 20,
      deadline: 120_000,
      now: () => Date.now(),
      token: secret,
      fetchFn
    })
    const rejected = expect(pending).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not follow a late redirect after deadline settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let resolveFetch!: (response: Response) => void
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    const pending = getBytes('artifacts/1/zip', {
      cap: 20,
      deadline: 120_000,
      now: () => Date.now(),
      token: secret,
      fetchFn
    })
    const rejected = expect(pending).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    resolveFetch(new Response(null, { status: 302, headers: { location: 'https://example.invalid/late' } }))
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a chunked body on overflow without echoing body contents', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(secret))
        },
        cancel
      })
    )
    await expect(
      getBytes('runs/1', { cap: 1, deadline: budget(), token: secret, fetchFn: async () => response })
    ).rejects.toThrow('transport-overflow')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe.skipIf(process.platform !== 'linux' || !hostedCi)('hosted native ZIP canary', () => {
  it('verifies selected bytes, CRC failure and policy rejection without extracting files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retained-profile-test-'))
    let cleanupAllowed = true
    try {
      await nativeCanary(dir, budget())
      expect(readdirSync(dir).every((file) => file.endsWith('.zip'))).toBe(true)
    } catch (error) {
      cleanupAllowed = closedFailure(error) !== 'native-unacknowledged'
      throw error
    } finally {
      if (cleanupAllowed) rmSync(dir, { recursive: true, force: true })
    }
  })
})
