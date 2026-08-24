import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A config of its own, deliberately.
 *
 * The repo's root vitest.config.ts scopes `include` to src/, intelligence/src/, scripts/ and eval/, so
 * its globs can never reach this directory — cloudflare-proxy/ is not part of the Electron app and ships
 * in no installer (electron-builder.yml's `files:` is an allowlist of out/ and package.json). That is why
 * package.json's `test` script chains `test:proxy`: the suite still runs under a single `npm test`, and
 * therefore in CI, rather than depending on someone remembering a second command.
 *
 * `root` is pinned to this directory rather than inherited from the shell's cwd so the command works
 * the same from the repo root and from here.
 *
 *   npm run test:proxy
 */
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
