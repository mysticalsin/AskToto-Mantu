/**
 * Mantu Intelligence QA group of the physical suite (M2-0410): `intelligence`.
 * Moved out of e2e-workflows.mjs verbatim; the harness helpers arrive through `ctx`.
 */
import { findPage, sleep } from '../lib/app-driver.mjs'

export function createIntelligenceGroup(ctx) {
const { page, browser, check, record, assert } = ctx

/**
 * Mantu Intelligence — the dashboard window, driven the way a user drives it.
 *
 * This whole surface had ZERO end-to-end coverage before: the suite's only touch was `graphify status
 * answers`, which proves an IPC handler replies and nothing about whether the dashboard renders. Nine
 * views ship in that window (Today, Coaching, Deals, Accounts, People, Stats, Relationships, Meetings,
 * Embed) and every one of them could throw on real data without a single test going red.
 *
 * It runs in its own BrowserWindow with its own narrow preload, so it is a separate CDP page reached
 * through window.toto.brainOpenDashboard() — not a route inside the main renderer.
 */
async function findIntelPage(browser, timeoutMs = 30000) {
  return findPage(
    browser,
    (p) => p.evaluate(() => typeof window.intelligence !== 'undefined'),
    `no page exposing window.intelligence after ${timeoutMs}ms`,
    timeoutMs,
    500
  )
}

/** Route the dashboard and wait for React to commit. HashRouter, because the window loads over
 *  file:// where a path-based router cannot round-trip. */
async function gotoIntelRoute(intel, route) {
  await intel.evaluate((r) => { window.location.hash = `#${r}` }, route)
  await sleep(900)
}

async function groupIntelligence() {
  const g = 'intelligence'
  let intel = null

  await check(g, 'the dashboard window opens from the main window', async () => {
    const r = await page.evaluate(() => window.toto.brainOpenDashboard())
    assert(r && r.ok, `brainOpenDashboard refused: ${JSON.stringify(r)}`)
    return r
  })

  await check(g, 'it loads the bundled dashboard, not the "bundle not found" error page', async () => {
    intel = await findIntelPage(browser)
    const title = await intel.title()
    const body = await intel.evaluate(() => document.body.innerText.slice(0, 400))
    assert(!/bundle not found/i.test(body), `dashboard failed to load its bundle: ${body.slice(0, 160)}`)
    return { title, chars: body.length }
  })

  if (!intel) {
    record(g, '(remaining dashboard checks)', 'info', 'not exercised — the dashboard page never appeared')
    return
  }

  // Security: this window is a READER. Its preload deliberately exposes four channels and nothing else,
  // so a bug (or an injected script) in the dashboard cannot reach the privileged main-window surface.
  await check(g, 'the dashboard preload stays read-only — no window.toto, no privileged writes', async () => {
    const surface = await intel.evaluate(() => ({
      hasToto: typeof window.toto !== 'undefined',
      keys: Object.keys(window.intelligence ?? {}).sort()
    }))
    assert(!surface.hasToto, 'the dashboard window can reach window.toto — that is the privileged main-window API')
    for (const forbidden of ['setSettings', 'setApiKey', 'ask', 'capture', 'saveTranscript']) {
      assert(!surface.keys.includes(forbidden), `dashboard preload exposes a privileged write: ${forbidden}`)
    }
    return surface.keys.join(',')
  })

  await check(g, 'getStatus answers with a coherent shape', async () => {
    const st = await intel.evaluate(() => window.intelligence.getStatus())
    assert(st && typeof st === 'object', 'getStatus returned nothing')
    return { meetings: st.meetings, people: st.people, deals: st.deals }
  })

  await check(g, 'getData returns the dashboard graph', async () => {
    const d = await intel.evaluate(() => window.intelligence.getData())
    assert(d && typeof d === 'object', 'getData returned nothing')
    return {
      people: d.people?.length ?? 0,
      deals: d.deals?.length ?? 0,
      meetings: d.meetings?.length ?? 0
    }
  })

  // The core of this group: every route a user can click must actually render. The ErrorBoundary is
  // keyed on the route, so a view that throws shows its fallback rather than a blank window — which
  // means a broken view is invisible to a test that only checks the window opened.
  const ROUTES = [
    ['/', 'Today'],
    ['/coaching', 'Coaching'],
    ['/deals', 'Deals'],
    ['/accounts', 'Accounts'],
    ['/people', 'People'],
    ['/stats', 'Stats'],
    ['/graph', 'Relationships'],
    ['/meetings', 'Meetings']
  ]
  for (const [route, label] of ROUTES) {
    await check(g, `${label} (${route}) renders without hitting the error boundary`, async () => {
      await gotoIntelRoute(intel, route)
      const state = await intel.evaluate(() => ({
        text: document.body.innerText,
        // vis-network mounts a canvas; the graph route is the one that can silently render nothing.
        canvases: document.querySelectorAll('canvas').length
      }))
      assert(
        !/hit an error and could/i.test(state.text),
        `${label} threw: ${state.text.replace(/\s+/g, ' ').slice(0, 200)}`
      )
      // A route that renders an empty <main> is as broken as one that throws, just quieter.
      assert(state.text.trim().length > 40, `${label} rendered almost nothing (${state.text.trim().length} chars)`)
      return route === '/graph' ? { chars: state.text.length, canvases: state.canvases } : { chars: state.text.length }
    })
  }

  // Regression: Stats and Relationships once reported different node/edge counts for the same data
  // under the same label, because Stats read the raw brain graph and Relationships read the filtered
  // display graph. Two numbers claiming to be the same number is a correctness bug, not a cosmetic one.
  // Regression: the "Graph nodes · edges" tile once showed the RAW brain graph while the Relationships
  // tab drew the FILTERED display graph, under one identical label. Meetings are deliberately dropped
  // from the display graph (brainAdapter keeps account|person|deal|sector — 61 meeting nodes would drown
  // the entity structure), so the two numbers diverge exactly when meeting nodes exist. Two numbers
  // claiming to be the same number is a correctness bug, not a cosmetic one.
  //
  // getData() returns the BRAIN shape; account_graph is built from it by brainToDashboard in the
  // renderer. So the expected filtered counts are derived here with the adapter's own predicate rather
  // than read off a field that only exists after adaptation.
  await check(g, 'the graph tile counts the DISPLAY graph, not the raw brain graph', async () => {
    await gotoIntelRoute(intel, '/stats')
    const statsTile = await intel.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((n) =>
        n.children.length === 0 && /Graph nodes/i.test(n.textContent ?? '')
      )
      return el?.parentElement?.innerText ?? null
    })
    assert(statsTile, 'the "Graph nodes · edges" tile is not on the Stats page')
    const nums = (statsTile.match(/\d+/g) ?? []).map(Number)
    assert(nums.length >= 2, `could not read two numbers out of the tile: ${JSON.stringify(statsTile)}`)
    const shownNodes = nums[nums.length - 2]
    const shownEdges = nums[nums.length - 1]

    const raw = await intel.evaluate(async () => {
      const b = await window.intelligence.getData()
      const KEEP = new Set(['account', 'person', 'deal', 'sector'])
      const all = b.graph?.nodes ?? []
      const kept = all.filter((n) => KEEP.has(n.type))
      const keptIds = new Set(kept.map((n) => n.id))
      const keptEdges = (b.graph?.edges ?? []).filter((e) => keptIds.has(e.from) && keptIds.has(e.to))
      return { allNodes: all.length, keptNodes: kept.length, keptEdges: keptEdges.length }
    })

    assert(
      shownNodes === raw.keptNodes && shownEdges === raw.keptEdges,
      `tile shows ${shownNodes}·${shownEdges}, the display graph has ${raw.keptNodes}·${raw.keptEdges}` +
        (shownNodes === raw.allNodes ? ' — that is the RAW brain count, the regression is back' : '')
    )
    return `${shownNodes} nodes · ${shownEdges} edges (raw brain graph has ${raw.allNodes} nodes)`
  })

  await check(g, 'a full pass over every route raises no uncaught error', async () => {
    const errors = []
    const onErr = (e) => errors.push(String(e.message ?? e))
    intel.on('pageerror', onErr)
    try {
      for (const [route] of ROUTES) await gotoIntelRoute(intel, route)
    } finally {
      intel.off('pageerror', onErr)
    }
    assert(errors.length === 0, `uncaught errors while navigating: ${errors.slice(0, 3).join(' | ')}`)
    return `${ROUTES.length} routes, 0 uncaught errors`
  })

  await check(g, 'the dashboard closes cleanly', async () => {
    await page.evaluate(() => window.toto.brainCloseDashboard?.()).catch(() => {})
    return 'closed (or already closed)'
  })
}

return { intelligence: groupIntelligence }
}
