#!/usr/bin/env node
/**
 * Guard: bans runtime `await import(...)` / dynamic `import(...)` in src/main.
 *
 * The main process is bytecode-compiled (electron-vite bytecodePlugin → out/main/index.jsc). V8 bytecode
 * has no dynamic-import host callback, so any dynamic import() throws "A dynamic import callback was not
 * specified." at runtime — invisible in `npm run dev` (runs source), fatal in the built app. This has
 * bitten Dust/Spotlight Ref, the recap summary, SSO sign-in, and the MCP connectors. Use static top-level
 * imports instead (all our deps ship CJS entries). Type-only `import('x').Type` positions are fine (erased
 * at compile time) and are not flagged because they don't use `await`/aren't a call in value position here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MAIN = join(ROOT, 'src', 'main')

/** Recursively collect .ts files under src/main, skipping test files. */
function collect(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...collect(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const violations = []
for (const file of collect(MAIN)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const code = line.trim()
    // Skip comment lines (the bytecode rationale comments mention "await import()" on purpose).
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
    if (/\bawait\s+import\s*\(/.test(line) || /[=([,]\s*import\s*\(/.test(line)) {
      violations.push(`${relative(ROOT, file)}:${i + 1}: ${code}`)
    }
  })
}

if (violations.length) {
  console.error('✗ Dynamic import() found in src/main — breaks under the bytecode build. Use a static import.\n')
  for (const v of violations) console.error('  ' + v)
  console.error('\nSee scripts/check-no-dynamic-import.mjs for why.')
  process.exit(1)
}
console.log('✓ No dynamic import() in src/main — bytecode-safe.')
