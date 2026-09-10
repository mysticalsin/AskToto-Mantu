import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isInsideResourceBase, realResourceBase } from './asr-model-path'

export interface AsrModelProtocolOptions {
  resourcesRoot: string
  userModelsRoot: string
  readLocal: (fileUrl: string) => Promise<Response>
}

/** Local asset protocol used by the renderer Whisper worker. */
export function createAsrModelProtocolHandler(options: AsrModelProtocolOptions): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    const respond = (body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response => {
      const headers = new Headers(init.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(body, { ...init, headers })
    }
    let url: URL
    let rel: string
    try {
      url = new URL(request.url)
      rel = decodeURIComponent(url.pathname).slice(1)
    } catch {
      return respond(null, { status: 400 })
    }
    try {
      if (url.protocol !== 'asr-model:' || (url.host !== 'models' && url.host !== 'ort') || url.username || url.password) {
        return respond(null, { status: 403 })
      }
      // Reject cross-platform path syntax before resolving. URL normalization alone does not catch
      // encoded separators, and a parent resources-root check would permit sibling app source files.
      if (isAbsolute(rel) || /[\\:\0]/.test(rel) || rel.split('/').includes('..')) return respond(null, { status: 403 })
      const roots = url.host === 'models'
        ? [join(options.resourcesRoot, 'models'), options.userModelsRoot]
        : [join(options.resourcesRoot, 'ort')]
      let real: string | undefined
      for (const root of roots) {
        try {
          const candidate = realpathSync(resolve(root, rel))
          if (!isInsideResourceBase(realResourceBase(root), candidate)) return respond(null, { status: 403 })
          if (!statSync(candidate).isFile()) return respond(null, { status: 404 })
          real = candidate
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (!real) return respond(null, { status: 404 })
      const response = await options.readLocal(pathToFileURL(real).toString())
      const types: Record<string, string> = {
        '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
        '.json': 'application/json', '.onnx': 'application/octet-stream', '.txt': 'text/plain'
      }
      const headers = new Headers(response.headers)
      const mime = types[extname(real).toLowerCase()]
      if (mime) headers.set('Content-Type', mime)
      if (!headers.has('Content-Length')) headers.set('Content-Length', String(statSync(real).size))
      return respond(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch {
      return respond(null, { status: 500 })
    }
  }
}
