import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { AskStart, Settings } from '@shared/ipc'
import { DealEntitySchema } from '@shared/brain'
import { userText } from './llm/shared'
import { readDeal, writeDeal, setDealOutcome, slugify } from './brain/store'
import { renameEntity, readAliasMap, resolveEntitySlug } from './brain/corrections'
import { settleCommitment } from './brain/ingest'

vi.mock('electron')

// Two ask-routing defects that live in index.ts's IPC handlers (MQA-009, MQA-013). index.ts boots the
// whole Electron app at import time and has no unit-test harness anywhere in this repo, so the WIRING is
// pinned against the actual source text — same pattern and rationale as pinned-agent-boundary.contract.
// test.ts — while the behavior each handler now depends on is proven for real against the live functions.
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Source text of the block opened by the first `{` at/after `marker`, brace-matched to its close. The
 *  regions matched below contain no unbalanced brace in a string or comment (template-literal `${…}`
 *  spans are balanced by construction), so a plain depth counter is exact here. */
function blockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced block after ${marker}`)
}

describe('MQA-009 — a fact-check ask still receives screenContext', () => {
  const BRAIN_GATE = "if (req.mode === 'answer' && req.kind !== 'factcheck') {"

  it('the screen-context injector is NOT nested inside the fact-check-excluded brainContext gate', () => {
    // The regression itself: nested here, `kind:'factcheck'` skipped the injector entirely and the
    // model was asked to fact-check a screen it received zero description of.
    const brainGate = blockAfter(indexSrc, BRAIN_GATE)
    expect(brainGate).not.toMatch(/req\.screenContext\s*=/)
    expect(brainGate).not.toMatch(/wantsScreenContext/)
  })

  it('the fact-check exclusion still applies to brainContext (that gate is deliberate — do not widen it)', () => {
    // personas.ts strips GROUNDING_RAIL for fact-check, so brainContext must stay out of it. Only the
    // screen block moved; it carries its own untrusted-data guard (llm/shared.ts screenContextBlock).
    const brainGate = blockAfter(indexSrc, BRAIN_GATE)
    expect(brainGate).toMatch(/buildBrainContext\(s,/)
    expect(brainGate).toMatch(/req\.brainContext = hit\.block \|\| undefined/)
  })

  it("the injector's own guard admits a fact-check ask and still excludes non-answer / non-screen asks", () => {
    // Evaluates the guard condition lifted verbatim out of index.ts, so a future edit that re-adds a
    // fact-check exclusion to the moved block fails here rather than silently at runtime.
    const injectorAt = indexSrc.indexOf('const ctx = screenPreprocess.currentFreshContext()')
    expect(injectorAt).toBeGreaterThan(-1)
    const condition = [...indexSrc.slice(0, injectorAt).matchAll(/if \(([^\n]*)\) \{/g)].pop()?.[1]
    expect(condition, 'no if-guard found above the screen injector').toBeTruthy()
    const guard = new Function('req', `return !!(${condition})`) as (req: Partial<AskStart>) => boolean

    expect(guard({ mode: 'answer', kind: 'factcheck', wantsScreenContext: true })).toBe(true)
    expect(guard({ mode: 'answer', wantsScreenContext: true })).toBe(true)
    expect(guard({ mode: 'answer', kind: 'factcheck' })).toBe(false)
    expect(guard({ mode: 'suggest', wantsScreenContext: true })).toBe(false)
  })

  it('a fact-check request carrying screenContext reaches the provider with the screen block attached', () => {
    // The consumer half: nothing downstream strips screenContext for kind:'factcheck', so injecting it
    // in main is sufficient — the verdict is now made against a described screen.
    const req = {
      id: 'x',
      mode: 'answer',
      kind: 'factcheck',
      prompt: 'Fact-check the most prominent claim visible on my screen.',
      history: [],
      screenContext: 'A slide claiming the market grew 400% last quarter.'
    } as AskStart
    const out = userText(req)
    expect(out).toContain('A slide claiming the market grew 400% last quarter.')
    expect(out).toMatch(/untrusted data/i)
  })
})

describe('MQA-013 — settle/outcome resolve a renamed deal by its stable id', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-ask-routing-test-'))
    s = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

  const DEAL_ID = 'acme-corp-core-banking'
  const PROMISE = 'send the revised pricing sheet'
  const NEW_NAME = 'Acme Core Banking'

  /** Plant a deal whose id will diverge from slugify(name) as soon as it is renamed. */
  const plantAndRename = async (): Promise<void> => {
    const deal = DealEntitySchema.parse({
      id: DEAL_ID,
      name: 'Acme Corp - Core Banking',
      account: 'Acme Corp',
      commitments: [{ text: PROMISE, by: 'you', meeting: '2026-06-01 intro.md', date: '2026-06-01' }]
    })
    await writeDeal(s, DEAL_ID, deal)
    const renamed = await renameEntity(s, { kind: 'deal', id: DEAL_ID, newName: NEW_NAME })
    expect(renamed.ok).toBe(true)
  }

  it('slugify(display name) no longer finds a renamed deal — the alias map does', async () => {
    await plantAndRename()
    // The rename keeps the id and the file (applyRename: "`id` (the slug) never changes"), so the old
    // brainSlugify(name) lookup pointed at a file that does not exist.
    expect(slugify(NEW_NAME)).not.toBe(DEAL_ID)
    expect(readDeal(s, slugify(NEW_NAME))).toBeNull()
    expect(resolveEntitySlug(readAliasMap(s), 'deal', NEW_NAME)).toBe(DEAL_ID)
  })

  it('settleCommitment fails on the slugified name and succeeds on the resolved id', async () => {
    await plantAndRename()
    const bySlug = await settleCommitment(s, slugify(NEW_NAME), PROMISE, 'kept')
    expect(bySlug).toEqual({ ok: false, error: 'Deal not found.' })

    const resolved = resolveEntitySlug(readAliasMap(s), 'deal', NEW_NAME)
    expect(await settleCommitment(s, resolved, PROMISE, 'kept')).toEqual({ ok: true })
    expect(readDeal(s, DEAL_ID)?.commitments[0]?.status).toBe('kept')
  })

  it('setDealOutcome fails on the slugified name and succeeds on the resolved id', async () => {
    await plantAndRename()
    expect(await setDealOutcome(s, slugify(NEW_NAME), 'won')).toBeNull()

    const resolved = resolveEntitySlug(readAliasMap(s), 'deal', NEW_NAME)
    expect((await setDealOutcome(s, resolved, 'won'))?.outcome).toBe('won')
    expect(readDeal(s, DEAL_ID)?.outcome).toBe('won')
  })

  it('an un-renamed deal still resolves to slugify(name) — the pre-fix path is unchanged', async () => {
    const deal = DealEntitySchema.parse({ id: DEAL_ID, name: 'Acme Corp - Core Banking', account: 'Acme Corp' })
    await writeDeal(s, DEAL_ID, deal)
    expect(resolveEntitySlug(readAliasMap(s), 'deal', 'Acme Corp - Core Banking')).toBe(slugify('Acme Corp - Core Banking'))
    expect(resolveEntitySlug(readAliasMap(s), 'deal', 'Never Seen Before')).toBe('never-seen-before')
  })

  it('both index.ts handlers route the wire name through the alias map, not brainSlugify', () => {
    const settle = blockAfter(indexSrc, 'ipcMain.handle(IPC.brainCommitmentSettle')
    expect(settle).toMatch(/settleCommitment\(s, resolveEntitySlug\(readAliasMap\(s\), 'deal', deal\)/)
    expect(settle).not.toMatch(/brainSlugify/)

    const outcome = blockAfter(indexSrc, 'ipcMain.handle(IPC.brainSetDealOutcome')
    expect(outcome).toMatch(/setDealOutcome\(s, resolveEntitySlug\(readAliasMap\(s\), 'deal', parsed\.data\.dealSlug\)/)
    expect(outcome).not.toMatch(/brainSlugify/)
  })
})

describe('MQA-228 — the screenshot-incapable advice respects the org allowlist', () => {
  it('the vision-gap message is built by visionSwitchAdvice, not a static provider pair', () => {
    expect(indexSrc).toMatch(/can't read screenshots\. \$\{visionSwitchAdvice\(provider\)\}/)
    expect(indexSrc).not.toMatch(/can't read screenshots\. Switch to Claude or GPT/)
  })

  it('the advice only ever names an ALLOWED vision-capable provider, preferring a configured one', () => {
    const body = blockAfter(indexSrc, 'const visionSwitchAdvice = (blocked: ProviderId): string =>')
    // Candidate filter: vision-capable AND on the allowlist (null allowlist = unrestricted), never local.
    expect(body).toMatch(/p !== blocked && p !== 'local' && providerVisionOk\(p\) && \(!allowed \|\| allowed\.includes\(p\)\)/)
    // Immediately-actionable first: a keyed / CLI-connected candidate outranks a merely-allowed one.
    expect(body).toMatch(/PROVIDERS\[p\]\.kind === 'cli' \? !!s\.cliConnected\[p\] : getApiKey\(p\)\.length > 0/)
  })

  it('a policy that leaves no vision route says so, instead of advising an impossible switch', () => {
    const body = blockAfter(indexSrc, 'const visionSwitchAdvice = (blocked: ProviderId): string =>')
    expect(body).toMatch(/Your organization's approved providers can't read screenshots/)
  })
})
