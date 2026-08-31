import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const IPC = readFileSync(join(__dirname, '..', 'shared', 'ipc.ts'), 'utf8')
const SETTINGS = readFileSync(join(__dirname, '..', 'renderer', 'src', 'components', 'Settings.tsx'), 'utf8')
const ANSWER = readFileSync(join(__dirname, '..', 'renderer', 'src', 'components', 'Answer.tsx'), 'utf8')
const APP = readFileSync(join(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8')

/**
 * MQA-269 — a user-ordered failover chain, and a failover that stops narrating itself.
 *
 * Failover was already automatic and silent on the wire — pickFailover walks to the next eligible
 * provider with no interruption, at all four seams (retry-budget sizing, pre-token failover,
 * dead-primary skip, hedge backup). What did not exist was any way for the user to say WHICH provider
 * is tried next: providerPriority is a two-value cli/api preference, not an order. And the UI narrated
 * every successful hop — the streaming byline and the thinking label re-render per attempt, so the user
 * watched the brand change mid-wait for a failover that worked.
 *
 * These are source-text pins (index.ts's askStart closure has no injectable seams — the same approach
 * provider-health-ux.contract.test.ts uses, and for the same reason).
 */
describe('MQA-269 — the user-authored chain', () => {
  it('exists in the schema with a safe default of empty = automatic', () => {
    expect(IPC).toMatch(/providerFallbackOrder: z\.array\(ProviderIdSchema\)\.max\(8\)\.default\(\[\]\)/)
    expect(IPC).toMatch(/providerFallbackOrder: \[\],/)
  })

  it('replaces BOTH guess-keys when present — cli bucket-swap and the free-tier float', () => {
    // preferFree would otherwise reorder the chain at exactly the moment the order matters most (the
    // primary just ran out). A chain the user typed must never be silently re-sorted.
    const at = INDEX.indexOf('const userOrder = s.providerFallbackOrder.filter')
    expect(at).toBeGreaterThan(-1)
    const block = INDEX.slice(at, at + 1400)
    expect(block).toMatch(/const order = userOrder\.length\s*\n?\s*\? \[\.\.\.userOrder, \.\.\.all\.filter/)
    // The automatic comparator survives intact for the empty-chain default.
    expect(block).toMatch(/providerPriority === 'cli'/)
    expect(block).toMatch(/preferFree/)
  })

  it('appends unlisted providers after the chain — a preference, not an allowlist', () => {
    // A user who adds a fourth key later must not silently lose failover to it.
    expect(INDEX).toMatch(/all\.filter\(\(p\) => !userOrder\.includes\(p\)\)/)
  })

  it('filters unknown ids and dedupes, so a stale or hand-edited profile cannot break the walk', () => {
    expect(INDEX).toMatch(/p in PROVIDERS && a\.indexOf\(p\) === i/)
  })

  it('the editor writes the chain head as the active provider in the SAME patch', () => {
    // "First in my chain" and "the provider that answers me" must be one fact, not two.
    expect(SETTINGS).toMatch(/patch\(\{ providerFallbackOrder: next, provider: next\[0\] \}\)/)
  })

  it('the editor offers only configured providers, filtered by the org allowlist', () => {
    // A chain naming a keyless provider is a chain of dead hops.
    const at = SETTINGS.indexOf('function FallbackOrderEditor')
    const block = SETTINGS.slice(at, at + 1600)
    expect(block).toMatch(/if \(allowed && !allowed\.includes\(p\)\) return false/)
    expect(block).toMatch(/settings\.hasKeys\?\.\[p\]/)
  })
})

describe('MQA-269 — the failover stops narrating itself', () => {
  it('the streaming byline no longer names the provider mid-stream', () => {
    // The row re-renders on every failover attempt; naming the provider made the brand flicker through
    // each hop. The after-the-fact `Answered by` byline is the one attribution surface.
    expect(ANSWER).not.toMatch(/Asking \$\{who\}/)
    expect(ANSWER).toMatch(/`Answered by \$\{who\}`/)
  })

  it('the thinking wait is a stable orb, not a brand or an elapsed-time hop (MQA-269)', () => {
    // The wait re-renders on every failover attempt. Naming the provider made the brand flicker.
    // Elapsed-time coaching ("Still working… (Ns)") was the old liveness signal — swapping that
    // string as seconds tick is a layout jump. Liveness is now the thinking orb; the word stays
    // Thinking. The after-the-fact `Answered by` byline is the one attribution surface.
    expect(ANSWER).toMatch(/<AgentStatus kind="thinking" size="hero"/)
    expect(ANSWER).toMatch(/<AgentStatus kind="working" size="inline" caption/)
    expect(ANSWER).not.toMatch(/Still working/)
    expect(ANSWER).not.toMatch(/thinkingSecs/)
    // The retired phrase survives in the comment recording WHY it was retired — that history must stay.
    // What must not exist is the template literal that rendered it.
    expect(ANSWER).not.toMatch(/\$\{who\} is on it/)
  })

  it('the streaming-to-idle settings refetch is gone — a standing state is not an event', () => {
    // It existed solely to pop the dead-key banner the instant a successful failover finished. The
    // notice still arrives on the next natural window focus.
    expect(APP).not.toMatch(/wasStreamingRef/)
    expect(APP).toMatch(/retires the MQA-053\/MQA-059 force-refetch/)
  })

  it('total failure still speaks — the terminal error paths are untouched', () => {
    // Silent failover is only honest while a walk that finds NOTHING still surfaces. pickFailover
    // returning null is the gate every user-visible askStart error sits behind.
    expect(INDEX).toMatch(/pickFailover/)
    expect(ANSWER.includes('Answered by')).toBe(true)
  })
})
