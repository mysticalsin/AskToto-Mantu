import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Own config, same reason as cloudflare-proxy/: the root vitest include globs never
 * reach operator/. Chained from package.json `test` via `test:operator`.
 *
 * Windows Quality failure (run 34066576111 tip d39895a7): vite-node skips transforming
 * in-repo `.mjs` and evaluates the raw source. Node's ESM loader strips a leading
 * `#!/usr/bin/env node` shebang; the vitest runner on Windows does not, so the `#`
 * becomes `SyntaxError: Invalid or unexpected token` and every contract suite that
 * imports `operator/scripts/*.mjs` loads 0 tests. Ubuntu/macOS pass because their
 * runner path still tolerates the shebang. Keep the shebang for CLI execution and
 * strip it only when vitest loads the module.
 */
function stripMjsShebang() {
  return {
    name: 'operator-strip-mjs-shebang',
    enforce: 'pre' as const,
    load(id: string) {
      const file = id.split('?')[0]
      if (!file.endsWith('.mjs')) return null
      let code: string
      try {
        code = readFileSync(file, 'utf8')
      } catch {
        return null
      }
      if (!code.startsWith('#!')) return null
      return code.replace(/^#![^\r\n]*\r?\n/, '')
    }
  }
}

export default defineConfig({
  plugins: [stripMjsShebang()],
  // Cross-boundary licence tests run in the Worker suite, using the real desktop HMAC signer.
  // Keep the Worker dependency graph out of the desktop-only test TypeScript project.
  resolve: { alias: { '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)) } },
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']
  }
})
