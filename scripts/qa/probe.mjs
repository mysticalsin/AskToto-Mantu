import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP(process.env.METIS_CDP ?? 'http://127.0.0.1:9334')
for (const c of b.contexts()) for (const p of c.pages()) {
  try {
    if (!(await p.evaluate(() => typeof window.toto !== 'undefined'))) continue
    const out = await p.evaluate(async () => ({
      status: await window.toto.brainStatus(),
      settings: await (async () => { const s = await window.toto.getSettings(); return {
        localReady: s.localReady, localFallbackReady: s.localFallbackReady, localRuntimeState: s.localRuntimeState,
        unhealthy: s.unhealthyProviders, hasKeys: Object.entries(s.hasKeys||{}).filter(([,v])=>v).map(([k])=>k)
      } })()
    }))
    console.log(JSON.stringify(out, null, 2))
    await b.close(); process.exit(0)
  } catch {}
}
process.exit(1)
