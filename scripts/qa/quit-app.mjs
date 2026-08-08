#!/usr/bin/env node
/** Ask a CDP-attached Métis to quit cleanly (QA harness teardown). Never fails the caller. */
import { chromium } from 'playwright-core'
const CDP = process.env.METIS_CDP ?? 'http://127.0.0.1:9334'
try {
  const b = await chromium.connectOverCDP(CDP)
  for (const c of b.contexts()) for (const p of c.pages()) {
    try { await p.evaluate(() => window.toto.quit()) } catch { /* not the toto page */ }
  }
  console.log('quit requested')
} catch {
  console.log('no app attached')
}
process.exit(0)
