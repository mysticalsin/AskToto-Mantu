import { defineConfig } from 'vitest/config'
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// W0-HERMETIC — consistency only, not a closed hazard for the OneDrive/brain-index defect this ticket
// fixes: this suite doesn't import src/main/transcripts.ts or src/main/brain/store.ts (see
// plan-work/prep/HERMETIC-TESTS.md §4.1), so it isn't exposed to the real-OneDrive path the root
// vitest.config.ts's hermetic home closes. Same sandbox anyway, so a future test that starts depending on
// homedir()-derived paths here doesn't silently reopen it un-noticed.
//
// This suite DOES already run Playwright (src/render/pages/overview.layout.test.ts), which resolves its
// browser cache from the home directory — pin PLAYWRIGHT_BROWSERS_PATH to the REAL cache or that test
// loses its Chromium the moment HOME below points somewhere fresh and empty.
function playwrightBrowsersPath(realHome: string): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  if (process.platform === 'darwin') return join(realHome, 'Library', 'Caches', 'ms-playwright')
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(realHome, 'AppData', 'Local'), 'ms-playwright')
  }
  return join(process.env.XDG_CACHE_HOME || join(realHome, '.cache'), 'ms-playwright')
}
const testHome = mkdtempSync(join(tmpdir(), 'metis-test-home-operator-'))
const testTmpDir = join(testHome, 'tmp')
mkdirSync(testTmpDir, { recursive: true })
const hermeticHomeEnv = {
  HOME: testHome,
  USERPROFILE: testHome,
  OneDrive: '',
  OneDriveCommercial: '',
  OneDriveConsumer: '',
  APPDATA: join(testHome, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(testHome, 'AppData', 'Local'),
  TMPDIR: testTmpDir,
  TMP: testTmpDir,
  TEMP: testTmpDir,
  PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(homedir())
}

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
    env: hermeticHomeEnv,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']
  }
})
