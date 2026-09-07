import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { binaryAssetResponse, isBinaryAssetPath, type AssetsBinding } from './assets'
import {
  SPA_CSS,
  SPA_CSS_PATH,
  SPA_INDEX_JS_PATH,
  SPA_JS,
  SPA_JS_PATH,
  SPA_WORLD_INDEX_PATH,
  SPA_WORLD_SVG,
  SPA_WORLD_SVG_PATH
} from './spa/manifest'
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
    expect(SPA_JS.length).toBeGreaterThan(40000)
    expect(SPA_CSS.length).toBeGreaterThan(2000)
    expect(SPA_JS).toMatch(/Shoey|overview|realtime|events/i)
    expect(SPA_JS).toContain("requested === 'map' ? 'realtime'")
    expect(SPA_JS).toContain('window.route = route')
    expect(SPA_JS).toContain('#E5E7EB')
    expect(SPA_JS).toContain('Created at')
    expect(SPA_JS).toContain('paintShoeyMap')
    expect(SPA_JS).toMatch(/data-iso=\\?"CA\\?"/)
    expect(SPA_JS).toMatch(/world-ocean/)
    expect(SPA_JS).toContain('ensureShoeyLand')
    expect(SPA_WORLD_SVG).toContain('data-iso="CA"')
    expect(SPA_WORLD_SVG).toContain('path class="world-land"')
    expect((SPA_WORLD_SVG.match(/data-iso="/g) || []).length).toBeGreaterThan(50)
    expect(SPA_JS).not.toMatch(/\bSEO\b/)
    expect(SPA_JS).toContain('key-add')
    expect(() => new Function(SPA_JS)).not.toThrow()
    expect(SPA_JS).not.toMatch(/self\.METIS_OPERATOR = self\.METIS_OPERATOR/)
    // Rail is 288px (reference Sidebar.tsx: w-72), not the old 185px Bklit-chrome width.
    expect(SPA_CSS).toContain('grid-template-columns: 288px 1fr')
    // Plan metis-portal-wow.md 3.3: body copy is 13px/19.5px Inter, not the measured-Shoey
    // 12px/1.4 system stack.
    expect(SPA_CSS).toContain('font: 400 13px/19.5px')
    expect(SPA_CSS).toContain('shoey-world')
    // Self-hosted @font-face now ships (plan 3.3, D5) -- woff2 built by
    // operator/scripts/build-assets.mjs into operator/public/fonts/, never a CDN link. The
    // system stack stays as the fallback tail of --font-body / --font-mono either way.
    expect(SPA_CSS).toContain('ui-sans-serif, system-ui, sans-serif')
    expect(SPA_CSS).toContain('ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas')
    expect(SPA_CSS).not.toContain('fonts.googleapis.com')
    expect(SPA_CSS).not.toContain('cdn.jsdelivr.net')
    expect(SPA_CSS).not.toContain('@import url(')
    // Amaris-skinned tokens (plan 3.2) supersede the measured-Shoey light palette; --def-100 is
    // now an alias of --bg, not a literal duplicate hex. Card radius is 14px (plan 3.4), not
    // the measured-Shoey 6.4px.
    expect(SPA_CSS).toContain('--bg: #f8f6fd')
    expect(SPA_CSS).toContain('--def-100: var(--bg)')
    expect(SPA_CSS).toContain('--radius-card: 14px')
    expect(SPA_JS_PATH).toMatch(/^\/assets\/operator-[0-9a-f]{12}\.js$/)
    expect(SPA_CSS_PATH).toMatch(/^\/assets\/operator-[0-9a-f]{12}\.css$/)
  })

  it('unauth GET hashed JS/CSS and /assets/index.js are 200 real files; unknown names 404', async () => {
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
    expect(cssBody).toContain('288px')
    // The map is a light choropleth matching the page canvas (plan 3.2, Tony 2026-09-06), not
    // the measured-Shoey exact grey land value.
    expect(cssBody).toContain('--map-land: #f0f0f0')
    expect(cssBody).not.toMatch(/cloudflareaccess/)

    const index = await handleRequest(new Request(`https://operator.test${SPA_INDEX_JS_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type') || '').toMatch(/javascript/)
    const indexBody = await index.text()
    expect(indexBody.length).toBeGreaterThan(97)
    expect(indexBody).toBe(jsBody)
    expect(indexBody).toContain('window.route = route')
    expect(indexBody).toContain('paintShoeyMap')
    expect(indexBody).toMatch(/data-iso=\\?"CA\\?"/)
    expect(indexBody).not.toMatch(/self\.METIS_OPERATOR = self\.METIS_OPERATOR/)
    expect(() => new Function(indexBody)).not.toThrow()

    const world = await handleRequest(new Request(`https://operator.test${SPA_WORLD_INDEX_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(world.status).toBe(200)
    expect(world.headers.get('content-type') || '').toMatch(/svg/)
    const worldBody = await world.text()
    expect(worldBody).toBe(SPA_WORLD_SVG)
    expect(worldBody).toContain('data-iso="CA"')
    expect(worldBody).toContain('class="world-ocean"')
    expect((worldBody.match(/data-iso="/g) || []).length).toBeGreaterThan(50)

    const hashedWorld = await handleRequest(new Request(`https://operator.test${SPA_WORLD_SVG_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(hashedWorld.status).toBe(200)
    expect(await hashedWorld.text()).toBe(worldBody)

    for (const path of ['/assets', '/assets/client.js', '/assets/operator-9f3c.js']) {
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

describe('binary assets (fonts, flags, logos) -- Workers Static Assets binding (plan D5, B8)', () => {
  it('recognises the three binary asset prefixes and nothing else under /assets/', () => {
    expect(isBinaryAssetPath('/assets/fonts/inter-variable-abc12345.woff2')).toBe(true)
    expect(isBinaryAssetPath('/assets/flags/us.svg')).toBe(true)
    expect(isBinaryAssetPath('/assets/logos/github.svg')).toBe(true)
    expect(isBinaryAssetPath(SPA_JS_PATH)).toBe(false)
    expect(isBinaryAssetPath(SPA_CSS_PATH)).toBe(false)
    expect(isBinaryAssetPath('/assets/world.svg')).toBe(false)
  })

  function fakeAssets(files: Record<string, string>): AssetsBinding {
    return {
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname
        const body = files[pathname]
        if (body === undefined) return new Response('not found', { status: 404 })
        return new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
      }
    }
  }

  it('strips the /assets prefix before calling the binding, and stamps immutable cache-control plus the baseline security headers', async () => {
    const assets = fakeAssets({ '/logos/github.svg': '<svg>github</svg>' })
    const request = new Request('https://operator.test/assets/logos/github.svg')
    const res = await binaryAssetResponse(request, { ASSETS: assets })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<svg>github</svg>')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('404s an unknown name, still with the baseline security headers, never a cached response', async () => {
    const assets = fakeAssets({ '/logos/github.svg': '<svg>github</svg>' })
    const request = new Request('https://operator.test/assets/logos/not-a-real-kind.svg')
    const res = await binaryAssetResponse(request, { ASSETS: assets })
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('fails closed to 404 when the ASSETS binding itself is not configured (e.g. local dev without static assets)', async () => {
    const request = new Request('https://operator.test/assets/fonts/inter-variable-abc12345.woff2')
    const res = await binaryAssetResponse(request, {})
    expect(res.status).toBe(404)
  })
})
