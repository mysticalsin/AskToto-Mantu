#!/usr/bin/env node
/** Ask a CDP-attached Métis to prewarm its local LLM so llama-server.exe exists before HK-W kills the app. */
import { chromium } from 'playwright'

const port = process.argv[2]
if (!port) {
  console.error('usage: hk-w-prewarm.mjs <cdp-port>')
  process.exit(2)
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
let asked = false
for (const context of browser.contexts()) {
  for (const page of context.pages()) {
    try {
      if (await page.evaluate(() => typeof window.toto !== 'undefined')) {
        await page.evaluate(() => window.toto.localPrewarm('HK-W hard-kill census'))
        asked = true
      }
    } catch {
      /* not the app page */
    }
  }
}
await browser.close().catch(() => {})
process.exit(asked ? 0 : 1)
