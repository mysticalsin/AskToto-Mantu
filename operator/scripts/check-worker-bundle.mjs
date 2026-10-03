#!/usr/bin/env node
/**
 * check-worker-bundle.mjs — CI gate. Bundles the Operator Worker entry the way the deploy does (one ESM
 * file, tree-shaken) and fails if the in-memory store is in it: `memoryStore` is for tests and the seed and
 * preview scripts only, so a Worker without its D1 binding can never fall back to an ephemeral store.
 *
 * Run: `npm run check:operator-bundle`
 */
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const OPERATOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
if (isMain) {
  const text = await bundleEntry()
  if (containsMemoryStore(text)) {
    console.error('Operator Worker bundle contains memoryStore: the in-memory store must be reachable only from tests and seed/preview scripts.')
    process.exit(1)
  }
  console.log('Operator Worker bundle does not contain memoryStore.')
}
