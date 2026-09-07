/**
 * Loads the REAL Operator license contract from `src/shared/operator-license.ts` (zero imports of
 * its own, same bundle-once pattern as `./hmac.mjs`) so the licensing scenario verifies a batch of
 * minted tokens with the product's own `verifyOperatorLicense`, not a reimplementation of it.
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..')

let cached = null

export async function loadLicense(scratchDir) {
  if (cached) return cached
  const entryFile = join(REPO_ROOT, 'src/shared/operator-license.ts')
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
  const outFile = join(dir, 'e2e-operator-license.out.mjs')
  await writeFile(outFile, result.outputFiles[0].text, 'utf8')
  cached = await import(pathToFileURL(outFile).href)
  return cached
}
