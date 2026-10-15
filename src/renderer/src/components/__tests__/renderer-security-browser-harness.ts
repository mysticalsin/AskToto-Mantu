import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../')
const RENDERER = join(ROOT, 'src/renderer')
const HARNESS_ID = '\0renderer-katex-security-harness'
const HOSTED_LIMIT_MS = 15_000
const CLOSE_LIMIT_MS = 5_000
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml'
}

type BrowserOptions = { width?: number; height?: number }
type BrowserPayload = { markdown?: string; caseId?: string }
type Origins = {
  katexDirect: string
  katexFromMermaid: string
  mermaidCore: string
  katexVersion: string
  browserVersion: string
}
type Diagnostics = {
  errors: string[]
  csp: string[]
  requests: string[]
  downloads: number
  dialogs: string[]
  pages: number
}
export type CasePage = { page: Page; context: BrowserContext; diagnostics: Diagnostics; close: () => Promise<void> }
type Harness = {
  origins: Origins
  open: (payload?: BrowserPayload, options?: BrowserOptions) => Promise<CasePage>
  close: () => Promise<void>
}

function deadline<T>(promise: Promise<T>, label: string, milliseconds = CLOSE_LIMIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`renderer-harness:${label}:deadline`)), milliseconds)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}:${error.message}` : String(error)).slice(0, 300)
}

function throwCleanupErrors(errors: string[]): void {
  if (errors.length)
    throw new Error(`renderer-harness:cleanup-failures:${errors.slice(0, 12).join('|').slice(0, 3_600)}`)
}

function cspFromProductionHtml(): string {
  const html = readFileSync(join(RENDERER, 'index.html'), 'utf8')
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/u)
  if (!match || !match[1]) throw new Error('renderer-harness:production-csp-missing')
  return match[1]
}

function fixtureSource(): string {
  return `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import '${RENDERER.replace(/\\/gu, '/')}/styles.css'
import { Markdown } from '${RENDERER.replace(/\\/gu, '/')}/src/components/Markdown.tsx'
import * as katexModule from 'katex'

const events = { errors: [], csp: [], downloads: 0, dialogs: [], pages: 0 }
window.addEventListener('error', event => events.errors.push(String(event.message || 'window-error')))
window.addEventListener('unhandledrejection', event => events.errors.push(String(event.reason?.message || event.reason || 'unhandled-rejection')))
document.addEventListener('securitypolicyviolation', event => events.csp.push(event.violatedDirective + ':' + event.blockedURI))
const rootElement = document.getElementById('fixture-root')
const root = createRoot(rootElement)
let currentMarkdown = ''
const renderMarkdown = (markdown) => {
  currentMarkdown = markdown
  flushSync(() => root.render(createElement(Markdown, { children: markdown })))
}
const katex = katexModule.default || katexModule
async function renderMermaid(source, config = {}) {
  const mermaidModule = await import('mermaid')
  const mermaid = mermaidModule.default || mermaidModule
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', ...config })
  const result = await mermaid.render('renderer-security-' + Math.random().toString(36).slice(2), source)
  const container = document.getElementById('diagram')
  container.innerHTML = result.svg
  result.bindFunctions?.(container)
  return result.svg
}
window.__rendererSecurity = {
  renderMarkdown,
  updateMarkdown: renderMarkdown,
  currentMarkdown: () => currentMarkdown,
  renderKatex: (expression, options = {}) => katex.renderToString(expression, options),
  renderMermaid,
  katexVersion: katex.version,
  root: rootElement,
  unmount: () => flushSync(() => root.unmount()),
  events
}
renderMarkdown(window.__rendererSecurityConfig?.markdown || '')
`
}

function originPlugin(origins: Record<string, string[]>): Plugin {
  return {
    name: 'renderer-katex-security-origin-observer',
    async resolveId(source, importer) {
      if (source === 'katex' && importer) {
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        if (resolved?.id) {
          const destination = /mermaid(?:\/|\\.)/u.test(importer) ? origins.katexFromMermaid : origins.katexDirect
          destination.push(resolve(resolved.id))
        }
      }
      return null
    },
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((item) => (item.type === 'chunk' ? Object.keys(item.modules) : []))
      const core = ids.find((id) => /node_modules[\\/]mermaid[\\/]dist[\\/]mermaid\.core\.mjs$/u.test(id))
      this.emitFile({
        type: 'asset',
        fileName: 'renderer-module-origins.json',
        source: JSON.stringify(
          {
            katexDirect: [...new Set(origins.katexDirect)],
            katexFromMermaid: [...new Set(origins.katexFromMermaid)],
            mermaidCore: core || null,
            outputModules: ids.map((id) => ({
              id: resolve(id),
              chunk: Object.values(bundle).find((item) => item.type === 'chunk' && item.modules[id])?.fileName
            }))
          },
          null,
          2
        )
      })
    }
  }
}

function boundedBody(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function sendFile(response: ServerResponse, file: string): void {
  const extension = extname(file)
  response.writeHead(200, {
    'content-type': MIME[extension] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-store'
  })
  createReadStream(file).pipe(response)
}

function serve(
  server: Server,
  root: string,
  csp: string,
  payloads: Map<string, BrowserPayload>,
  origins: Origins
): void {
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/case/')) {
      const key = url.pathname.slice('/case/'.length)
      if (!payloads.has(key)) {
        response.writeHead(404).end()
        return
      }
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><script src="/fixture-config.js?key=${key}"></script></head><body><div id="fixture-root"></div><div id="diagram"></div><script type="module" src="/harness.js"></script></body></html>`
      boundedBody(response, html)
      return
    }
    if (url.pathname === '/fixture-config.js') {
      const payload = payloads.get(url.searchParams.get('key') || '')
      if (!payload) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(`window.__rendererSecurityConfig=${JSON.stringify(payload)};`)
      return
    }
    if (url.pathname === '/renderer-module-origins.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(origins))
      return
    }
    const normalized = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/gu, '')
    const file = resolve(root, normalized)
    if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) {
      response.writeHead(404).end()
      return
    }
    sendFile(response, file)
  })
}

export async function startRendererSecurityHarness(): Promise<Harness> {
  const temp = mkdtempSync(join(tmpdir(), 'renderer-katex-security-'))
  const output = join(temp, 'bundle')
  mkdirSync(output, { recursive: true })
  const maps: Record<string, string[]> = { katexDirect: [], katexFromMermaid: [] }
  let server: Server | undefined
  let browser: Browser | undefined
  const contexts = new Set<BrowserContext>()
  const payloads = new Map<string, BrowserPayload>()
  try {
    const outputResult = (await build({
      root: ROOT,
      configFile: false,
      logLevel: 'silent',
      define: { __METIS_QA_IDENTITY__: 'false', __METIS_FEEDBACK_EMAIL__: '""' },
      resolve: { alias: { '@': join(RENDERER, 'src'), '@shared': join(ROOT, 'src/shared') } },
      plugins: [
        tailwindcss(),
        react(),
        {
          name: 'renderer-katex-security-entry',
          resolveId: (id) => (id === HARNESS_ID ? id : null),
          load: (id) => (id === HARNESS_ID ? fixtureSource() : null)
        },
        originPlugin(maps)
      ],
      build: {
        outDir: output,
        emptyOutDir: false,
        minify: false,
        cssCodeSplit: false,
        sourcemap: false,
        rollupOptions: {
          input: HARNESS_ID,
          output: {
            format: 'es',
            entryFileNames: 'harness.js',
            assetFileNames: (asset) => (asset.name?.endsWith('.css') ? 'harness.css' : '[name]-[hash][extname]')
          }
        }
      }
    })) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const chunks = (Array.isArray(outputResult) ? outputResult : [outputResult])
      .flatMap((result) => result.output)
      .filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
    if (!chunks.some((chunk) => chunk.isEntry && chunk.fileName === 'harness.js'))
      throw new Error('renderer-harness:external-entry-missing')
    const manifestPath = join(output, 'renderer-module-origins.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      katexDirect: string[]
      katexFromMermaid: string[]
      mermaidCore: string | null
    }
    const direct = manifest.katexDirect.filter((id) => id.includes(`${sep}katex${sep}`))
    const dynamic = manifest.katexFromMermaid.filter((id) => id.includes(`${sep}katex${sep}`))
    const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/katex/package.json'), 'utf8')) as { version: string }
    const origins: Origins = {
      katexDirect: direct[0] || '',
      katexFromMermaid: dynamic[0] || '',
      mermaidCore: manifest.mermaidCore || '',
      katexVersion: pkg.version,
      browserVersion: ''
    }
    server = createServer()
    serve(server, output, cspFromProductionHtml(), payloads, origins)
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolveReady, reject) => {
      server?.once('listening', () => resolveReady())
      server?.once('error', reject)
    })
    browser = await chromium.launch({ headless: true })
    origins.browserVersion = browser.version()
    const evidenceDir = process.env.METIS_RENDERER_EVIDENCE_DIR
    if (evidenceDir) {
      const runnerTemp = process.env.RUNNER_TEMP
      if (!runnerTemp || !resolve(evidenceDir).startsWith(`${resolve(runnerTemp)}${sep}`))
        throw new Error('renderer-harness:evidence-path-not-owned-temp')
      writeFileSync(join(evidenceDir, `harness-origin-${randomUUID()}.json`), `${JSON.stringify(origins, null, 2)}\n`, {
        flag: 'wx'
      })
    }
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('renderer-harness:loopback-bind-missing')
    const origin = `http://127.0.0.1:${address.port}`
    return {
      origins,
      open: async (payload = {}, options = {}) => {
        const key = randomUUID()
        payloads.set(key, payload)
        const context = await browser!.newContext({
          viewport: { width: options.width || 1200, height: options.height || 800 }
        })
        contexts.add(context)
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
        const page = await context.newPage()
        const diagnostics: Diagnostics = { errors: [], csp: [], requests: [], downloads: 0, dialogs: [], pages: 1 }
        await context.route('**/*', async (route) => {
          const requestUrl = new URL(route.request().url())
          if (requestUrl.origin !== origin) {
            diagnostics.requests.push(`${requestUrl.protocol}//${requestUrl.host}${requestUrl.pathname}`)
            await route.abort('blockedbyclient')
            return
          }
          await route.continue()
        })
        page.on('pageerror', (error) => diagnostics.errors.push(error.message.slice(0, 300)))
        page.on('download', () => {
          diagnostics.downloads++
        })
        page.on('dialog', (dialog) => {
          diagnostics.dialogs.push(dialog.type())
          void dialog.dismiss()
        })
        context.on('page', () => {
          diagnostics.pages++
        })
        try {
          await page.goto(`${origin}/case/${key}`, { waitUntil: 'load', timeout: HOSTED_LIMIT_MS })
          await page.waitForFunction(() => Boolean((window as any).__rendererSecurity), null, {
            timeout: HOSTED_LIMIT_MS
          })
          return {
            page,
            context,
            diagnostics,
            close: async () => {
              const cleanupErrors: string[] = []
              try {
                await deadline(context.close(), 'context-close')
              } catch (error) {
                cleanupErrors.push(errorText(error))
              } finally {
                contexts.delete(context)
                payloads.delete(key)
              }
              throwCleanupErrors(cleanupErrors)
            }
          }
        } catch (error) {
          const cleanupErrors: string[] = []
          try {
            await deadline(context.close(), 'failed-context-close')
          } catch (cleanupError) {
            cleanupErrors.push(errorText(cleanupError))
          }
          contexts.delete(context)
          payloads.delete(key)
          const original = errorText(error)
          throw new Error(
            `renderer-harness:open-failed:${original}${cleanupErrors.length ? `;cleanup:${cleanupErrors.join('|')}` : ''}`,
            { cause: error }
          )
        }
      },
      close: async () => {
        const cleanupErrors: string[] = []
        for (const context of contexts) {
          try {
            await deadline(context.close(), 'context-close')
          } catch (error) {
            cleanupErrors.push(errorText(error))
          }
        }
        contexts.clear()
        try {
          if (browser) await deadline(browser.close(), 'browser-close')
        } catch (error) {
          cleanupErrors.push(errorText(error))
        }
        try {
          if (server?.listening)
            await deadline(
              new Promise<void>((resolveClose, reject) =>
                server!.close((error) => (error ? reject(error) : resolveClose()))
              ),
              'server-close'
            )
        } catch (error) {
          cleanupErrors.push(errorText(error))
        }
        try {
          rmSync(temp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        } catch (error) {
          cleanupErrors.push(errorText(error))
        }
        throwCleanupErrors(cleanupErrors)
      }
    }
  } catch (error) {
    const cleanupErrors: string[] = []
    for (const context of contexts) {
      try {
        await deadline(context.close(), 'failed-context-close')
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
    }
    if (browser) {
      try {
        await deadline(browser.close(), 'failed-browser-close')
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
    }
    if (server?.listening) {
      try {
        await deadline(
          new Promise<void>((resolveClose, reject) =>
            server!.close((closeError) => (closeError ? reject(closeError) : resolveClose()))
          ),
          'failed-server-close'
        )
      } catch (cleanupError) {
        cleanupErrors.push(errorText(cleanupError))
      }
    }
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch (cleanupError) {
      cleanupErrors.push(errorText(cleanupError))
    }
    const original = errorText(error)
    throw new Error(
      `renderer-harness:start-failed:${original}${cleanupErrors.length ? `;cleanup:${cleanupErrors.join('|')}` : ''}`,
      { cause: error }
    )
  }
}

export async function expectNoUnexpectedEffects(test: CasePage): Promise<void> {
  const browserEvents = await test.page.evaluate(() => (window as any).__rendererSecurity.events)
  test.diagnostics.errors.push(...browserEvents.errors)
  test.diagnostics.csp.push(...browserEvents.csp)
  if (
    test.diagnostics.errors.length ||
    test.diagnostics.requests.length ||
    test.diagnostics.csp.length ||
    test.diagnostics.downloads ||
    test.diagnostics.dialogs.length ||
    test.diagnostics.pages !== 1
  ) {
    throw new Error(
      `renderer-harness:unexpected-effects:${JSON.stringify({ ...test.diagnostics, errors: test.diagnostics.errors.length, requests: test.diagnostics.requests.length, csp: test.diagnostics.csp.length })}`
    )
  }
}

export async function openHarnessPage(
  harness: Harness,
  payload?: BrowserPayload,
  options?: BrowserOptions
): Promise<CasePage> {
  return harness.open(payload, options)
}

export async function closeHarnessPage(testPage: CasePage): Promise<void> {
  await testPage.close()
}

export async function waitForCode(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: HOSTED_LIMIT_MS })
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
