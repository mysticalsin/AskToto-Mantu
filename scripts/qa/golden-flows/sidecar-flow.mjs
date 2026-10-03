// Long-answer layout check for the right-edge sidecar drawer (M2-0410), split from onboarding-flows.mjs.
// `ctx.win` and `ctx.app` are read at call time because the window is replaced during onboarding.
import { sleep as delay } from '../lib/app-driver.mjs'

// This response deliberately contains the three shapes that previously made the narrow right-edge
// drawer look broken: a long unbroken prose token, a wide code line, and a wide markdown table. It is
// delivered through the normal ask IPC/stream lifecycle by an isolated test-only main-process handler;
// no network provider or user credential is involved.
const SIDECAR_LONG_RESPONSE = [
  '## Sidecar layout check',
  `The sidecar must wrap this unbroken token without widening: ${'metisrightedge'.repeat(72)}`,
  '```ts\nconst deliberatelyWideCodeLine = "' + 'sidecar-code'.repeat(54) + '"\n```',
  '| Surface | Required behavior | Regression payload |',
  '| --- | --- | --- |',
  `| Composer | Stays anchored | ${'table-cell'.repeat(42)} |`
].join('\n\n')

/**
 * @param ctx `{ app, win, ok }`
 */
export function createSidecarFlow(ctx) {
  const { ok } = ctx

  async function installSidecarResponseFixture() {
    await ctx.app.evaluate(({ ipcMain }, response) => {
      // E2E owns this throwaway Electron process. Replacing just ask:start preserves the production
      // renderer → preload → IPC → stream event path while making the payload deterministic and offline.
      ipcMain.removeHandler('ask:start')
      ipcMain.handle('ask:start', (event, request) => {
        const id = request && typeof request.id === 'string' ? request.id : ''
        if (!id) throw new Error('E2E ask fixture received no request id.')
        queueMicrotask(() => {
          event.sender.send('stream:delta', { id, text: response })
          event.sender.send('stream:done', { id, inputTokens: 1, outputTokens: 1 })
        })
      })
    }, SIDECAR_LONG_RESPONSE)

    const settings = await ctx.win.evaluate(async () => {
      // The test-only handler above never sends a request to OpenAI. This inert key solely satisfies the
      // renderer's normal provider-readiness gate, using the disposable local profile created by this run.
      await window.toto.setSettings({ provider: 'openai' })
      await window.toto.setApiKey('openai', 'metis-e2e-fixture-key')
      return window.toto.getSettings()
    })
    if (!settings.providerReady || settings.provider !== 'openai') {
      throw new Error(`Could not prepare the isolated sidecar response fixture: ${JSON.stringify({ provider: settings.provider, providerReady: settings.providerReady })}`)
    }
    // useSettings refreshes after the main-process settings change. Trigger its normal focus refresh and
    // wait long enough for the React gate to observe the disposable ready provider before pressing Enter.
    await ctx.win.evaluate(() => window.dispatchEvent(new Event('focus')))
    await delay(300)
  }

  async function verifyLongSidecarResponse(composer) {
    await installSidecarResponseFixture()
    await composer.fill('Render the offline sidecar layout fixture')
    await composer.press('Enter')

    const response = ctx.win.locator('section[aria-label="Métis response"]')
    await response.waitFor({ state: 'visible', timeout: 8_000 })
    await response.getByText('Sidecar layout check', { exact: false }).waitFor({ state: 'visible', timeout: 8_000 })
    const layout = await ctx.win.evaluate(() => {
      const drawer = document.querySelector('.right-edge-sidecar__drawer')
      const body = document.querySelector('.right-edge-sidecar__body')
      const answer = document.querySelector('.right-edge-sidecar__answer')
      const composer = document.querySelector('.right-edge-sidecar__composer')
      const drawerScroll = document.querySelector('.right-edge-sidecar__drawer-scroll')
      if (!(drawer instanceof HTMLElement) || !(body instanceof HTMLElement) || !(answer instanceof HTMLElement) || !(composer instanceof HTMLElement) || !(drawerScroll instanceof HTMLElement)) return null
      const rect = (element) => {
        const value = element.getBoundingClientRect()
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height }
      }
      return {
        drawer: rect(drawer),
        body: { ...rect(body), clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
        answer: { ...rect(answer), clientWidth: answer.clientWidth, scrollWidth: answer.scrollWidth },
        composer: rect(composer),
        drawerScroll: { clientWidth: drawerScroll.clientWidth, scrollWidth: drawerScroll.scrollWidth },
        code: [...answer.querySelectorAll('pre')].map((pre) => ({ clientWidth: pre.clientWidth, scrollWidth: pre.scrollWidth })),
        table: [...answer.querySelectorAll('table')].map((table) => ({ clientWidth: table.clientWidth, scrollWidth: table.scrollWidth }))
      }
    })
    const horizontalOverflow = layout && [layout.body, layout.answer, layout.drawerScroll, ...layout.table].some((element) => element.scrollWidth > element.clientWidth + 1)
    const composerAnchored = layout && layout.composer.bottom >= layout.drawer.bottom - 15 && layout.composer.top > layout.body.bottom
    if (!layout || horizontalOverflow || !composerAnchored) {
      throw new Error(`Long sidecar response escaped its reading surface: ${JSON.stringify({ layout, horizontalOverflow, composerAnchored })}`)
    }
    ok('long sidecar answer wraps prose and tables while the composer remains anchored')
  }

  return { verifyLongSidecarResponse }
}
