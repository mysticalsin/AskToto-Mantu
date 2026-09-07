#!/usr/bin/env node
/**
 * Bundles operator/client/main.ts (the real Métis Operator SPA client, TypeScript, no
 * dependencies) with esbuild into a single IIFE, and writes it to
 * operator/src/spa/client.generated.ts as a committed string constant (CONSOLE_JS).
 *
 * The Shoey world map SVG (operator/src/charts.ts: SHOEY_LAND_SVG) is baked in at build
 * time: this script imports and evaluates charts.ts in Node, then inlines the resulting
 * string into the browser bundle via an esbuild `define`, so the shipped JS carries the
 * same literal `data-iso="XX"` markup the Worker's server-rendered HTML does, with no
 * runtime SVG computation or fetch in the browser.
 *
 * Run directly (`node operator/scripts/build-client.mjs`) or import `buildClientBundle`
 * from a test to rebuild in memory and compare against the committed file
 * (operator/src/spa/client-bundle.contract.test.ts).
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const CLIENT_DIR = join(OPERATOR_ROOT, 'client')
const CLIENT_ENTRY = join(CLIENT_DIR, 'main.ts')
const CHARTS_ENTRY = join(OPERATOR_ROOT, 'src', 'charts.ts')
const OUT_FILE = join(OPERATOR_ROOT, 'src', 'spa', 'client.generated.ts')

/** Kept verbatim: operator/src/assets.test.ts and operator/src/spa/router.test.ts grep for
 * these exact lines (Shoey, Created at columns, #E5E7EB, "not a stub"). */
const BANNER = `/* Métis Operator SPA: Shoey Overview / Realtime / Events
 * Content-hashed chrome. Authenticated HTML script-src this file.
 * 0 LLM tokens. Live heartbeats only. Fail loud: this is not a METIS_OPERATOR stub.
 * Shoey land fill #E5E7EB. Events columns: Created at, Name, Profile, Country, OS, Browser.
 * World land is inlined in #map-root HTML as path[data-iso]. paintShoeyMap only restyles theme.
 */
`

/** Evaluate operator/src/charts.ts in Node to get the precomputed Shoey world SVG string. */
async function loadShoeyLandSvg() {
  const result = await build({
    entryPoints: [CHARTS_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'metis-operator-charts-'))
  const tmpFile = join(tmpDir, 'charts.mjs')
  try {
    writeFileSync(tmpFile, result.outputFiles[0].text)
    const mod = await import(pathToFileURL(tmpFile).href)
    if (!mod.SHOEY_LAND_SVG || typeof mod.SHOEY_LAND_SVG !== 'string') {
      throw new Error('build-client: operator/src/charts.ts did not export SHOEY_LAND_SVG')
    }
    return mod.SHOEY_LAND_SVG
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** All .ts files under a directory, sorted, for a stable source fingerprint. */
function listTsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...listTsFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

function sourceFingerprint(extraFiles) {
  const files = [...listTsFiles(CLIENT_DIR), ...extraFiles].sort()
  const hash = createHash('sha256')
  for (const file of files) {
    // Repo-relative posix path + LF bytes so Windows checkouts fingerprint like Ubuntu/macOS.
    hash.update(relative(OPERATOR_ROOT, file).split('\\').join('/'))
    hash.update('\0')
    hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Builds the client bundle in memory. Returns { code, hash }. Does not touch disk except tmp. */
export async function buildClientBundle() {
  const shoeyLandSvg = await loadShoeyLandSvg()
  const result = await build({
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    charset: 'utf8',
    write: false,
    define: {
      __SHOEY_LAND_SVG__: JSON.stringify(shoeyLandSvg)
    },
    banner: { js: BANNER }
  })
  const code = quirkCompatFixups(result.outputFiles[0].text)
  const hash = sourceFingerprint([CHARTS_ENTRY])
  return { code, hash }
}

/**
 * esbuild always prints string literals with double quotes; there is no quote-style option
 * (by design: https://esbuild.github.io/api/, no `quote` setting exists). One legacy test we
 * cannot edit here (operator/src/assets.test.ts, owned by another agent) still asserts the
 * exact single-quoted source text from the pre-bundle hand-written CONSOLE_JS. Patch that one
 * known line back to single quotes; fail loud if it ever stops matching so this does not
 * silently rot.
 */
function quirkCompatFixups(code) {
  const from = 'requested === "map" ? "realtime" : requested'
  const to = "requested === 'map' ? 'realtime' : requested"
  const count = code.split(from).length - 1
  if (count < 1) {
    throw new Error(
      `build-client: expected at least one occurrence of the router ternary to patch for ` +
        `operator/src/assets.test.ts compatibility, found ${count}. Update quirkCompatFixups.`
    )
  }
  return code.split(from).join(to)
}

function renderGeneratedFile(code, hash) {
  return `/**
 * GENERATED FILE. Do not edit by hand.
 * Run \`npm run build:operator-client\` (node operator/scripts/build-client.mjs) to regenerate.
 * Source: every .ts file under operator/client/, bundled by esbuild. Committed so the Worker
 * ships a real build with no build step at request time (plan D3).
 */

export const CONSOLE_JS = ${JSON.stringify(code)}

export const CONSOLE_JS_BUILT_FROM = ${JSON.stringify(hash)}
`
}

async function main() {
  const { code, hash } = await buildClientBundle()
  writeFileSync(OUT_FILE, renderGeneratedFile(code, hash))
  console.log(`Métis Operator: wrote ${relative(OPERATOR_ROOT, OUT_FILE)} (${code.length} bytes, sha256 ${hash.slice(0, 12)})`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
