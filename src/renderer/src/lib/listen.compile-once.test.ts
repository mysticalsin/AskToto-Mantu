/**
 * MQA-173 — useListen's ASR-correction and entity-casing regexes must be compiled once per LIST change,
 * which is what both call sites document ("Compiled once per corrections-list change (not per line)",
 * listen.ts; "Exported so callers (useListen) can compile once per entityNames change instead of per
 * transcribed line", entity-casing.ts).
 *
 * They were bare assignments in the hook body, so they ran once per RENDER instead. useListen is called
 * from App.tsx, and useAsk's rAF-batched flush re-renders App ~60x/s for the whole of a streaming answer
 * — so a 500-name brain (the brain:entityNames cap) rebuilt 500 Unicode RegExps per animation frame.
 *
 * There is no jsdom / @testing-library harness in this repo (vitest runs the `node` environment, see
 * vitest.config.ts), so the hook is driven through a minimal hooks host — the same approach
 * lib/tap/tap-control.audit.test.ts already uses. Only the render body matters here, so effects are
 * recorded and never committed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Slot = { current: unknown }

const host = vi.hoisted(() => {
  let slots: Slot[] = []
  let cursor = 0
  const slot = <T,>(initial: T): { current: T } => {
    const i = cursor++
    if (!slots[i]) slots[i] = { current: initial }
    return slots[i] as { current: T }
  }
  return {
    useRef: slot,
    useState<T>(initial: T): [T, (v: unknown) => void] {
      const s = slot(initial)
      return [
        s.current,
        (v: unknown) => {
          s.current = typeof v === 'function' ? (v as (p: T) => T)(s.current) : (v as T)
        }
      ]
    },
    beginRender(): void {
      cursor = 0
    },
    reset(): void {
      slots = []
      cursor = 0
    }
  }
})

vi.mock('react', () => ({
  useRef: <T,>(initial: T) => host.useRef(initial),
  useState: <T,>(initial: T) => host.useState(initial),
  useEffect: () => {},
  useCallback: <T,>(fn: T) => fn,
  useMemo: <T,>(fn: () => T) => fn()
}))

const counts = vi.hoisted(() => ({ entityCompiles: 0 }))

vi.mock('./entity-casing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-casing')>()
  return {
    ...actual,
    compileEntityCasingCandidates: (names: string[]) => {
      counts.entityCompiles++
      return actual.compileEntityCasingCandidates(names)
    }
  }
})

// Imported after the mocks so the hook binds to the host above.
const { useListen } = await import('./listen')

type Correction = { from: string; to: string }

/** A corrections array that counts how many times the compile chain started (its first step is `.filter`).
 *  Identity-stable across renders, which is exactly what the guard under test keys on. */
function countingCorrections(items: Correction[]): { list: Correction[]; compiles: () => number } {
  let n = 0
  const list = new Proxy(items, {
    get(target, key, receiver) {
      if (key === 'filter') n++
      return Reflect.get(target, key, receiver)
    }
  })
  return { list, compiles: () => n }
}

const render = (corrections: Correction[] | undefined, entityNames: string[] | undefined): void => {
  host.beginRender()
  useListen(undefined, corrections, undefined, '', entityNames)
}

beforeEach(() => {
  host.reset()
  counts.entityCompiles = 0
})

describe('MQA-173 — useListen compiles its regexes once per list change, not once per render', () => {
  it('MQA-173 — does not recompile the entity-casing regexes on renders with the same entityNames', () => {
    const entityNames = ['L’Oréal', 'Acme Corporation', 'Toto Industries']

    render(undefined, entityNames)
    expect(counts.entityCompiles).toBe(1)

    // What a streaming answer does: ~60 re-renders a second with no input change at all.
    for (let i = 0; i < 60; i++) render(undefined, entityNames)

    expect(counts.entityCompiles).toBe(1)
  })

  it('MQA-173 — does not recompile the correction regexes on renders with the same corrections', () => {
    const { list, compiles } = countingCorrections([{ from: 'toto', to: 'Toto' }])

    render(list, undefined)
    expect(compiles()).toBe(1)

    for (let i = 0; i < 60; i++) render(list, undefined)

    expect(compiles()).toBe(1)
  })

  it('MQA-173 — still recompiles when the list itself changes', () => {
    const first = ['Acme Corporation']
    render(undefined, first)
    expect(counts.entityCompiles).toBe(1)

    render(undefined, ['Acme Corporation', 'L’Oréal']) // a brain refresh hands back a new array
    expect(counts.entityCompiles).toBe(2)

    render(undefined, undefined) // asrEntityBias switched off
    expect(counts.entityCompiles).toBe(3)
  })
})
