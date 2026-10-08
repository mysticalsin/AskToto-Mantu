import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { queryMainLogPath } from './main-log-query.mjs'

const BOUND_MS = 10_000
type Evaluation = { expression: string; returnByValue: boolean; awaitPromise?: boolean }

function synchronousClient(candidateProcess: object) {
  return {
    send: vi.fn(async (method: string, params: Evaluation, timeoutMs: number) => {
      expect(method).toBe('Runtime.evaluate')
      expect(timeoutMs).toBe(BOUND_MS)
      expect(Object.keys(params).sort()).toEqual(['expression', 'returnByValue'])
      expect(params.returnByValue).toBe(true)
      if (params.awaitPromise) throw new Error('Runtime.evaluate: Promise was collected')
      const value = runInNewContext(params.expression, { process: candidateProcess }, { timeout: 500 })
      // Do not await this result: an accidental asynchronous expression must fail this regression.
      expect(value).not.toBeInstanceOf(Promise)
      expect(value?.then).toBeUndefined()
      return { late: false, result: { result: { value } } }
    })
  }
}

function candidate(getPath: (name: string) => string) {
  return {
    mainModule: {
      require(name: string) {
        if (name === 'node:path') return posix
        if (name === 'electron') return { app: { getPath } }
        throw new Error('unexpected synthetic require')
      }
    }
  }
}

describe('ST-1 synchronous main-log query', () => {
  it('evaluates the actual synchronous expression without asking CDP to await its value', async () => {
    const getPath = vi.fn((name: string) => {
      expect(name).toBe('logs')
      return '/synthetic/logs'
    })
    const cdp = synchronousClient(candidate(getPath))
    await expect(queryMainLogPath(cdp, BOUND_MS)).resolves.toEqual({
      late: false,
      value: { path: '/synthetic/logs/main.log' }
    })
    expect(cdp.send).toHaveBeenCalledTimes(1)
    expect(getPath).toHaveBeenCalledTimes(1)
  })

  it('preserves the unavailable compiled-main loader diagnostic', async () => {
    const cdp = synchronousClient({})
    await expect(queryMainLogPath(cdp, BOUND_MS)).resolves.toEqual({
      late: false,
      value: { error: 'process.mainModule.require is unavailable in the compiled main' }
    })
  })

  it('preserves a synchronous candidate-side lookup failure', async () => {
    const cdp = synchronousClient(
      candidate(() => {
        throw new Error('synthetic logs unavailable')
      })
    )
    await expect(queryMainLogPath(cdp, BOUND_MS)).resolves.toEqual({
      late: false,
      value: { error: 'synthetic logs unavailable' }
    })
  })

  it('returns a late transport response without reading its absent result', async () => {
    const answer = { late: true }
    const cdp = { send: vi.fn(async () => answer) }
    await expect(queryMainLogPath(cdp, BOUND_MS)).resolves.toBe(answer)
    expect(cdp.send).toHaveBeenCalledTimes(1)
  })

  it('rejects evaluation exceptions using the existing protocol text', async () => {
    const cdp = {
      send: vi.fn(async () => ({ late: false, result: { exceptionDetails: { text: 'synthetic evaluation failed' } } }))
    }
    await expect(queryMainLogPath(cdp, BOUND_MS)).rejects.toThrow('synthetic evaluation failed')
  })

  it('preserves a rejected transport for the caller to record', async () => {
    const failure = new Error('synthetic transport failed')
    const cdp = {
      send: vi.fn(async () => {
        throw failure
      })
    }
    await expect(queryMainLogPath(cdp, BOUND_MS)).rejects.toBe(failure)
  })

  it('changes only the synchronous locator wiring, keeping asynchronous probes pinned', () => {
    const source = readFileSync('scripts/qa/st-1.mjs', 'utf8')
    expect(source).toContain("import { queryMainLogPath } from './lib/main-log-query.mjs'")
    expect(source).toContain('const answer = await queryMainLogPath(cdp, MAIN_LOG_QUERY_TIMEOUT_MS)')
    expect(source).not.toContain('cdp.evaluate(MAIN_LOG_PATH')
    expect(source).toContain('{ expression, awaitPromise: true, returnByValue: true }')
    expect(source).toContain('cdp.evaluate(pinnedExpression(key, expression, ms), ms + EVALUATE_MARGIN_MS)')
    expect(source).toContain("evaluateBounded(cdp, 'sample', sampleExpression(probeFile), SAMPLE_TIMEOUT_MS)")
    expect(source).toContain("evaluateBounded(cdp, 'summary', SUMMARY, SETUP_TIMEOUT_MS)")
  })
})
