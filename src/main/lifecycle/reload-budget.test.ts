import { describe, it, expect } from 'vitest'
import { createReloadBudget } from './reload-budget'

describe('createReloadBudget', () => {
  it('allows the first 3 render-process-gone events within 60s, then halts the 4th', () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
    t = 1
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
    t = 2
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
    t = 3
    // 4th event, still well inside the 60s window since the first — over budget.
    expect(budget.onRenderProcessGone('crashed')).toBe('halt')
  })

  it('keeps halting while the exhausting events stay inside the 60s window', () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    budget.onRenderProcessGone('crashed')
    t = 1
    budget.onRenderProcessGone('crashed')
    t = 2
    budget.onRenderProcessGone('crashed')
    t = 3
    expect(budget.onRenderProcessGone('crashed')).toBe('halt')
    t = 50_000 // still < 60s after the earliest (t=0) reload
    expect(budget.onRenderProcessGone('crashed')).toBe('halt')
  })

  it('allows reloading again once the exhausting events have aged out of the 60s window', () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    budget.onRenderProcessGone('crashed')
    t = 1
    budget.onRenderProcessGone('crashed')
    t = 2
    budget.onRenderProcessGone('crashed')
    t = 3
    expect(budget.onRenderProcessGone('crashed')).toBe('halt')
    t = 60_003 // 60s+ after every one of 0,1,2,3 — the whole history has aged out
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
  })

  it("ignores 'clean-exit' — it never reloads and never counts against the budget", () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    expect(budget.onRenderProcessGone('clean-exit')).toBe('ignore')
    t = 1
    expect(budget.onRenderProcessGone('clean-exit')).toBe('ignore')
    t = 2
    expect(budget.onRenderProcessGone('clean-exit')).toBe('ignore')
    t = 3
    // Three prior clean-exits must not have consumed any of the 3-reload budget.
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
  })

  it.each(['abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const)(
    "counts reason=%s toward the budget the same as 'crashed'",
    (reason) => {
      let t = 0
      const budget = createReloadBudget(() => t)
      budget.onRenderProcessGone(reason)
      t = 1
      budget.onRenderProcessGone(reason)
      t = 2
      budget.onRenderProcessGone(reason)
      t = 3
      expect(budget.onRenderProcessGone(reason)).toBe('halt')
    }
  )

  it('resets the whole history once the reloaded content stays alive for 30s past did-finish-load', () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    budget.onRenderProcessGone('crashed')
    t = 1
    budget.onRenderProcessGone('crashed')
    t = 2
    budget.onRenderProcessGone('crashed')
    // The 3rd reload's content loads and stays up for the full alive window.
    t = 10
    budget.onDidFinishLoad()
    t = 10 + 30_000
    // A brand-new crash, still inside the original 60s window measured from t=0, is treated as a fresh
    // start because the prior reload demonstrably recovered — it must not inherit the old streak.
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
  })

  it('does NOT reset early — a crash less than 30s after did-finish-load still counts against the budget', () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    budget.onRenderProcessGone('crashed')
    t = 1
    budget.onRenderProcessGone('crashed')
    t = 2
    budget.onRenderProcessGone('crashed')
    t = 10
    budget.onDidFinishLoad()
    t = 10 + 29_999 // one ms short of the 30s alive requirement
    expect(budget.onRenderProcessGone('crashed')).toBe('halt')
  })

  it('a did-finish-load with no following render-process-gone is harmless (no-op until read)', () => {
    let t = 0
    const budget = createReloadBudget(() => t)
    budget.onDidFinishLoad()
    t = 1
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
  })

  it('works with the default clock when none is given', () => {
    const budget = createReloadBudget()
    expect(budget.onRenderProcessGone('crashed')).toBe('reload')
  })
})
