#!/usr/bin/env node
/**
 * check-worker-bundle.mjs — CI gate. Bundles the Operator Worker entry the way the deploy does (one ESM
 * file, tree-shaken) and fails if the in-memory store is in it: `memoryStore` is for tests and the seed and
 * preview scripts only, so a Worker without its D1 binding can never fall back to an ephemeral store.
 *
 * Run: `npm run check:operator-bundle`
 */
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const OPERATOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

/** Bundle `entry` (a path under operator/) to a string. Node built-ins stay external: the Worker runtime
 *  provides them and they are irrelevant to what this gate looks for. */
export async function bundleEntry(entry = 'src/index.ts') {
  const result = await build({
    entryPoints: [join(OPERATOR_ROOT, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*'],
    logLevel: 'silent'
  })
  return result.outputFiles.map((file) => file.text).join('\n')
}

/** True when the bundle text carries the in-memory store. */
export function containsMemoryStore(bundleText) {
  return /\bmemoryStore\b/.test(bundleText)
}

/** True when the Worker bundle carries the QA dashboard fixture. */
export function containsQaDashboardFixture(bundleText) {
  return /\bfixtureRows\b|\bfixtureDashboard\b|\bFIXTURE_NOW\b/.test(bundleText)
}

async function readOutputFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const chunks = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      chunks.push(await readOutputFiles(path))
    } else if (entry.isFile() && ['.js', '.mjs', '.json', '.map', '.txt'].includes(extname(entry.name))) {
      chunks.push(await readFile(path, 'utf8'))
    }
  }
  return chunks.join('\n')
}

/** Bundle through Wrangler's dry-run deploy path and return the emitted Worker text. */
export async function wranglerDryRunOutput() {
  const outdir = await mkdtemp(join(tmpdir(), 'metis-operator-worker-'))
  try {
    const wrangler = require.resolve('wrangler/bin/wrangler.js')
    await execFileAsync(process.execPath, [wrangler, 'deploy', '--dry-run', '--outdir', outdir, '--config', 'wrangler.jsonc'], {
      cwd: OPERATOR_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 10 * 1024 * 1024
    })
    return await readOutputFiles(outdir)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
if (isMain) {
  const text = await wranglerDryRunOutput()
  if (containsMemoryStore(text)) {
    console.error('Wrangler Worker output contains memoryStore: the in-memory store must be reachable only from tests and seed/preview scripts.')
    process.exit(1)
  }
  if (containsQaDashboardFixture(text)) {
    console.error('Wrangler Worker output contains the QA dashboard fixture: fixtures must stay in operator/test/ only.')
    process.exit(1)
  }
  console.log('Wrangler Worker output contains neither memoryStore nor the QA dashboard fixture.')
}
