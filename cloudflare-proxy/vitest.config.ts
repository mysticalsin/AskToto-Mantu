import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A config of its own, deliberately.
 *
 * The repo's root vitest.config.ts scopes `include` to src/, intelligence/src/, scripts/ and eval/, so
 * this directory is invisible to `npm test` — which is correct: cloudflare-proxy/ is not part of the
 * Electron app, ships in no installer (electron-builder.yml's `files:` is an allowlist of out/ and
 * package.json), and adding it to the root run would change the suite's file count for a tree the app
 * build never touches.
 *
 * `root` is pinned to this directory rather than inherited from the shell's cwd so the command works
 * the same from the repo root and from here.
 *
 *   ./node_modules/.bin/vitest run --config cloudflare-proxy/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
