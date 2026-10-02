import { describe, expect, it } from 'vitest'
import { buildReport, hostedOutcomeForExit, IDLE_SLEEP_WAKE_ROW, parseCheckOutput } from './stall-sampler-hosted.mjs'

describe('stall-sampler-hosted report builder', () => {
  it('parses the shell check PASS lines into a content-free PASS report', () => {
    const check = parseCheckOutput({
      exitCode: 0,
      stdout: [
        'helper 123 after boot (cputime rss_kb): 00:00.12 9136',
        'helper 123 after stop (cputime rss_kb): 00:00.31 10024',
        'PASS stop: stall-boot-1.txt, 4096 bytes, raw left: 0, detection latency: 19s',
        'PASS parent death: helper exited in 500ms'
      ].join('\n'),
      stderr: ''
    })
    expect(check).toEqual({
      exitCode: 0,
      failure: null,
      helper: {
        'after-boot': { cputime: '00:00.12', rss_kb: 9136 },
        'after-stop': { cputime: '00:00.31', rss_kb: 10024 }
      },
      bundleSizeBytes: 4096,
      detectionLatencyMs: 19_000,
      helperExitMs: 500
    })

    const report = buildReport({
      check,
      stopSeconds: 15,
      stallWatchChildCount: 1,
      bundleCount: 1,
      appStallSampledCount: 1
    })
    expect(report).toMatchObject({
      result: 'PASS',
      stop_seconds: 15,
      stall_watch_child_count: 1,
      bundle_count: 1,
      app_stall_sampled_count: 1,
      bundle_size_bytes: 4096,
      detection_latency_ms: 19_000,
      helper: {
        after_boot: { cputime: '00:00.12', rss_kb: 9136 },
        after_stop: { cputime: '00:00.31', rss_kb: 10024 },
        exit_after_main_kill_ms: 500
      }
    })
    expect(JSON.stringify(report)).not.toMatch(/[\\/@]/)
  })

  it('always emits the 60 minute idle plus sleep/wake row as BLOCKED_EXTERNAL', () => {
    const report = buildReport({
      check: parseCheckOutput({ stdout: 'PASS parent death: helper exited in 0ms', stderr: '' }),
      stopSeconds: 15,
      stallWatchChildCount: 1,
      bundleCount: 1,
      appStallSampledCount: 1
    })
    expect(report.rows).toContainEqual(IDLE_SLEEP_WAKE_ROW)
    expect(report.rows.find((row) => row.row === 'idle-60m-sleep-wake')).toMatchObject({
      status: 'BLOCKED_EXTERNAL',
      unblock: expect.stringContaining('long-lived or physical macOS QA host')
    })
  })

  it('records FAIL lines and sampler-access failures without retrying or changing the stop duration', () => {
    const check = parseCheckOutput({
      exitCode: 1,
      stdout: 'helper 123 after boot (cputime rss_kb): 00:00.01 9000',
      stderr: 'FAIL: expected 1 bundle after the stop, found 0\n'
    })
    const report = buildReport({
      check,
      stopSeconds: 15,
      stallWatchChildCount: 1,
      bundleCount: 0,
      appStallSampledCount: 0,
      samplerError: true
    })
    expect(report.result).toBe('FAIL')
    expect(report.stop_seconds).toBe(15)
    expect(report.rows).toEqual(
      expect.arrayContaining([
        { row: 'sampler-access', status: 'FAIL', reason: 'sampler-error-recorded' },
        { row: 'check-script', status: 'FAIL', reason: 'expected 1 bundle after the stop, found 0' }
      ])
    )
  })

  it('sanitizes path-like shell failures before they enter the report', () => {
    const check = parseCheckOutput({
      exitCode: 1,
      stdout: '',
      stderr: 'FAIL: not a sampler-enabled profile: /var/folders/profile\n'
    })
    const report = buildReport({
      check,
      stopSeconds: 15,
      stallWatchChildCount: 0,
      bundleCount: 0,
      appStallSampledCount: 0
    })
    expect(report.rows).toContainEqual({
      row: 'check-script',
      status: 'FAIL',
      reason: 'stall sampler check failed before content-free detail could be recorded'
    })
    expect(JSON.stringify(report)).not.toContain('/var/folders')
  })

  it('maps hosted process exits to PASS, FAIL and PRECONDITION', () => {
    expect(hostedOutcomeForExit(0)).toBe('PASS')
    expect(hostedOutcomeForExit(1)).toBe('FAIL')
    expect(hostedOutcomeForExit(2)).toBe('PRECONDITION')
    expect(hostedOutcomeForExit(null)).toBe('FAIL')
  })
})
