import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { SPA_CSS, SPA_CSS_PATH, SPA_JS, SPA_JS_PATH } from './spa/manifest'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_TEAM_DOMAIN } from './test-fixtures'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    TEAM_DOMAIN: TEST_TEAM_DOMAIN
  }
}

describe('hashed SPA assets — fail loud if a stub ships', () => {
  it('bundle is real Shoey chrome, not the 97-byte METIS_OPERATOR stub', () => {
    expect(SPA_JS.length).toBeGreaterThan(2000)
    expect(SPA_CSS.length).toBeGreaterThan(2000)
    expect(SPA_JS).toMatch(/Shoey|overview|realtime|events/i)
    expect(SPA_JS).toContain("requested === 'map' ? 'realtime'")
    expect(SPA_JS).toContain('key-add')
    expect(SPA_JS).not.toMatch(/self\.METIS_OPERATOR = self\.METIS_OPERATOR/)
    expect(SPA_CSS).toContain('grid-template-columns: 185px 1fr')
    expect(SPA_CSS).toContain('font: 12px/1.4')
    expect(SPA_CSS).toContain('shoey-world')
    expect(SPA_JS_PATH).toMatch(/^\/assets\/operator-[0-9a-f]{12}\.js$/)
    expect(SPA_CSS_PATH).toMatch(/^\/assets\/operator-[0-9a-f]{12}\.css$/)
  })

  it('unauth GET hashed JS/CSS are 200 real files; stubs and unknown names 404', async () => {
    const js = await handleRequest(new Request(`https://operator.test${SPA_JS_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type') || '').toMatch(/javascript/)
    const jsBody = await js.text()
    expect(jsBody.length).toBeGreaterThan(97)
    expect(jsBody).toContain('Overview')
    expect(jsBody).toContain('Realtime')
    expect(jsBody).toContain('Events')
    expect(jsBody).toContain('Shoey')
    expect(jsBody).not.toMatch(/302 Found|cloudflareaccess|cdn-cgi\/access/)

    const css = await handleRequest(new Request(`https://operator.test${SPA_CSS_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type') || '').toMatch(/text\/css/)
    const cssBody = await css.text()
    expect(cssBody.length).toBeGreaterThan(97)
    expect(cssBody).toContain('185px')
    expect(cssBody).not.toMatch(/cloudflareaccess/)

    for (const path of ['/assets', '/assets/index.js', '/assets/client.js', '/assets/operator-9f3c.js']) {
      const res = await handleRequest(new Request(`https://operator.test${path}`), env(), {}, {
        store: memoryStore(),
        now: NOW
      })
      expect(res.status, path).toBe(404)
      const type = res.headers.get('content-type') || ''
      expect(type, path).not.toMatch(/text\/html/)
      const body = await res.text()
      expect(body, path).not.toContain('self.METIS_OPERATOR')
      expect(body, path).not.toMatch(/cdn-cgi\/access/)
    }
  })
})
