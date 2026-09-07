/**
 * Loads the REAL device-ingest HMAC contract from `src/shared/operator-hmac.ts` (the module the
 * Worker's `operator/src/hmac.ts` and the desktop's `src/main/operator-hmac-sign.ts` both build on)
 * so the e2e seat simulator signs exactly the same canonical string a real Métis seat signs,
 * instead of a second, driftable reimplementation of it.
 *
 * `src/shared/operator-hmac.ts` has zero imports of its own, so bundling it alone (no path aliases
 * to resolve) is enough: esbuild here plays the same role `operator/scripts/seed-local.mjs`'s
 * `loadFixtureModule` already plays for `operator/src/render/fixture.ts`.
 *
 * The actual HMAC-SHA256 signing (`node:crypto`) mirrors `src/main/operator-hmac-sign.ts`
 * byte-for-byte: `sha256HexUtf8` then `hmac(secret, ingestCanonical(ts, nonce, deviceId, bodyHash))`.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..')

let cached = null

async function bundleSharedHmac(scratchDir) {
  const entryFile = join(REPO_ROOT, 'src/shared/operator-hmac.ts')
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    logLevel: 'silent'
  })
  const dir = join(scratchDir, 'esbuild-tmp')
  await mkdir(dir, { recursive: true })
  const outFile = join(dir, 'e2e-operator-hmac.out.mjs')
  await writeFile(outFile, result.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outFile).href)
}

/** Returns `{ ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_HMAC_SKEW_MS, sha256HexUtf8, sign,
 *  headersFor }`, loading and caching the real shared module on first call. */
export async function loadHmac(scratchDir) {
  if (cached) return cached
  const shared = await bundleSharedHmac(scratchDir)
  const { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_HMAC_SKEW_MS } = shared

  function sha256HexUtf8(body) {
    return createHash('sha256').update(body, 'utf8').digest('hex')
  }

  /** Same algorithm as `src/main/operator-hmac-sign.ts#signOperatorIngest`. */
  function sign(secret, ts, nonce, deviceId, body) {
    return createHmac('sha256', secret).update(ingestCanonical(ts, nonce, deviceId, sha256HexUtf8(body))).digest('hex')
  }

  /** Same algorithm as `src/main/operator-hmac-sign.ts#operatorHmacHeaders`, with every field
   *  overridable so a scenario can build a deliberately bad request (wrong sig, stale ts, replayed
   *  nonce) for the auth/privacy scenario without a second signer. */
  function headersFor(secret, deviceId, body, opts = {}) {
    const ts = opts.ts ?? String(opts.now ?? Date.now())
    const nonce = opts.nonce ?? randomUUID()
    const sig = opts.sig ?? sign(secret, ts, nonce, deviceId, body)
    return {
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: sig
    }
  }

  cached = { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_HMAC_SKEW_MS, sha256HexUtf8, sign, headersFor }
  return cached
}
