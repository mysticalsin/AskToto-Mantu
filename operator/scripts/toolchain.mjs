import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const LOCAL_TOOLS = Object.freeze({
  wrangler: 'wrangler/bin/wrangler.js',
  typescript: 'typescript/bin/tsc',
  vitest: 'vitest/vitest.mjs'
})

/** Never let a production gate download or select a different executable through npx.
 * npm ci installs these tools from the committed lockfile, including the exact Wrangler pin. */
export function localNodeCommand(tool, args = []) {
  if (!Object.hasOwn(LOCAL_TOOLS, tool)) throw new Error(`Unsupported local tool: ${tool}`)
  return { cmd: process.execPath, args: [join(REPO_ROOT, 'node_modules', LOCAL_TOOLS[tool]), ...args] }
}

/** A killed process and a plain exit=1 with empty output are not network failures. Preserve them
 * explicitly instead of reducing every failure to a context-free "Command failed" message. */
export function commandFailureDetails(result) {
  const status = result.status ?? 'null'
  const signal = result.signal || 'none'
  const error = result.error?.code || (result.error ? result.error.name || 'unknown' : 'none')
  return [`exit=${status} signal=${signal} error=${error}`, result.stdout || '', result.stderr || '']
    .filter(Boolean).join('\n').trim()
}
