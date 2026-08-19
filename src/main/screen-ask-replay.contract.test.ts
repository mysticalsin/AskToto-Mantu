import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StreamMetaSchema } from '@shared/ipc'

/**
 * Source contract for the screen-ask REPLAY path — Retry / "Go deeper" on an answer that saw the screen.
 *
 * Both defects live in the IPC.askStart handler, a single large closure with no injectable seam (there is
 * no index.test.ts — same rationale as ask-degradation-fixes.contract.test.ts and
 * pinned-agent-boundary.contract.test.ts beside it), so the wiring is pinned against the real source. The
 * renderer half of each fix is exercised behaviourally in ../renderer/src/state.useAsk.test.ts.
 *
 *  MQA-182 — the renderer keeps the last vision request verbatim (state.ts lastReqRef) so Retry can replay
 *            the screenshot. Nothing on that path re-checked Private View, so a frame captured before the
 *            switch went on was re-sent to the cloud after it. A stored frame is still the screen.
 *  MQA-180 — the screen fast path sends an INTENT flag only (wantsScreenContext); main re-derives the
 *            description from its own cache. On a replay that cache is usually empty, so the ask reached
 *            the provider with zero screen data while the UI still showed "Viewed screen".
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const stateSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'state.ts'), 'utf8').replace(
  /\r\n/g,
  '\n'
)
const appSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n'
)

const askStartStart = indexSrc.indexOf('ipcMain.handle(IPC.askStart')
const askStartBody = indexSrc.slice(
  askStartStart,
  indexSrc.indexOf('const allowed = getAllowedProviders()', askStartStart)
)

describe('MQA-182 — Private View blocks a REPLAYED screenshot at the ask boundary', () => {
  it('askStart refuses any request carrying a screenshot while Private View is on', () => {
    expect(askStartStart).toBeGreaterThan(-1)
    // Keyed on the payload (req.image), not on mode: the schema permits an image on a non-vision mode,
    // so gating on `mode === 'vision'` would be narrower than the invariant.
    expect(askStartBody).toMatch(/if \(req\.image && privateViewOn\(\)\)/)
  })

  it('audits the refusal like every other capture block, and tells the user why', () => {
    const guard = askStartBody.slice(askStartBody.indexOf('if (req.image && privateViewOn())'))
    expect(guard.slice(0, 700)).toMatch(/auditLog\('capture\.blocked', \{ reason: 'private_view', at: 'ask' \}\)/)
    expect(guard.slice(0, 700)).toMatch(/IPC\.streamError/)
    expect(guard.slice(0, 700)).toMatch(/PRIVATE_VIEW_BLOCKED_MESSAGE/)
    // It must STOP: falling through would ship the frame to the provider anyway.
    expect(guard.slice(0, 700)).toMatch(/\n\s+return\n/)
  })

  it('the refusal copy is the one getScreenshot already throws — one wording for one promise', () => {
    expect(indexSrc).toMatch(/const PRIVATE_VIEW_BLOCKED_MESSAGE =/)
    expect(indexSrc).toMatch(/super\(PRIVATE_VIEW_BLOCKED_MESSAGE\)/)
    // The renderer's Private-View copy path keys off this phrasing (App.tsx /private view/i).
    const decl = indexSrc.slice(indexSrc.indexOf('const PRIVATE_VIEW_BLOCKED_MESSAGE ='))
    expect(decl.slice(0, 300)).toMatch(/private view/i)
  })
})

describe('MQA-180 — main reports whether the answer actually saw the screen', () => {
  it('derives the verdict from what was really injected, not from the renderer intent flag', () => {
    expect(askStartBody).toMatch(
      /const screenGrounded =\s*[\s\S]{0,200}req\.wantsScreenContext[\s\S]{0,80}!!req\.screenContext/
    )
    // The verdict is derived AFTER the injection block that may or may not fill req.screenContext.
    expect(askStartBody.indexOf("if (req.mode === 'answer' && req.wantsScreenContext) {")).toBeLessThan(
      askStartBody.indexOf('const screenGrounded =')
    )
  })

  it('every stream:meta announcement carries the verdict, including the hedge re-assert', () => {
    const sends = indexSrc.match(/send\(IPC\.streamMeta, \{[^}]*\}\)/g) ?? []
    expect(sends.length).toBeGreaterThanOrEqual(2)
    for (const send of sends) expect(send).toMatch(/usedScreen: screenGrounded/)
  })

  it('StreamMeta carries the verdict as an optional field — absent means "no verdict"', () => {
    // Parsed THROUGH, not stripped: an unknown key would be dropped by z.object and the verdict lost.
    const verdict = StreamMetaSchema.parse({ id: 'a', provider: 'anthropic', tier: 'base', usedScreen: false })
    expect(verdict.usedScreen).toBe(false)
    const noVerdict = StreamMetaSchema.parse({ id: 'a', provider: 'anthropic', tier: 'base' })
    expect(noVerdict.usedScreen).toBeUndefined()
    // …and the existing contract still holds.
    expect(StreamMetaSchema.safeParse({ id: 'a', tier: 'base' }).success).toBe(false)
  })

  it('the renderer obeys the verdict instead of its own optimistic flag', () => {
    const onMeta = stateSrc.slice(stateSrc.indexOf('const offMeta = window.toto.onMeta'))
    expect(onMeta.slice(0, 900)).toMatch(/m\.usedScreen/)
  })

  it('announces the degrade instead of silently answering without the screen', () => {
    // Same contract as the live capture path: a screen ask that ends up without the screen says so
    // (App.tsx's captureError banner), it does not just quietly drop the badge.
    expect(appSrc).toMatch(/const SCREEN_CONTEXT_LOST_NOTICE =/)
    expect(appSrc).toMatch(/ask\.answer\?\.screenMissed/)
  })
})
