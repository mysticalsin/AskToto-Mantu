/**
 * Tiny assertion collector shared by every scenario (`../scenarios/*.mjs`). No test framework: a
 * scenario just builds one `Check()`, calls `.that(...)` (or `.fail(...)`) as many times as it
 * needs, and returns `check.result(name, startedAt)` to `run.mjs`. A failed `.that()` records the
 * defect (file/line/expected/actual) and keeps going, so one scenario reports every defect it found
 * in one run instead of stopping at the first.
 */

export class Check {
  constructor() {
    /** @type {{ message: string, file?: string, line?: number, expected?: unknown, actual?: unknown }[]} */
    this.failures = []
    /** @type {string[]} */
    this.passed = []
  }

  /** Records a pass/fail. `detail` may carry `{ file, line, expected, actual }` for a failure so the
   *  report names the exact product location and the mismatch, never just "something broke". */
  that(condition, message, detail = {}) {
    if (condition) {
      this.passed.push(message)
    } else {
      this.failures.push({ message, ...detail })
    }
    return condition
  }

  /** Unconditional failure (e.g. an HTTP call itself threw, or returned an unexpected status). */
  fail(message, detail = {}) {
    this.failures.push({ message, ...detail })
  }

  get ok() {
    return this.failures.length === 0
  }

  result(name, startedAt, extra = {}) {
    return {
      name,
      status: this.ok ? 'pass' : 'fail',
      durationMs: Date.now() - startedAt,
      passedCount: this.passed.length,
      failures: this.failures,
      ...extra
    }
  }
}

export function skipped(name, reason) {
  return { name, status: 'skip', durationMs: 0, passedCount: 0, failures: [], reason }
}
