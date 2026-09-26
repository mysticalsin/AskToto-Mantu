import { defineConfig } from 'vitest/config'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// W0-HERMETIC — consistency only, not a closed hazard here: this suite doesn't import
// src/main/transcripts.ts or src/main/brain/store.ts (see plan-work/prep/HERMETIC-TESTS.md §4.1), so it
// isn't exposed to the real-OneDrive path the root vitest.config.ts's hermetic home closes. Same sandbox
// anyway, so a future test that starts depending on homedir()-derived paths here doesn't silently reopen
// it un-noticed.
const testHome = mkdtempSync(join(tmpdir(), 'metis-test-home-proxy-'))
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
  TEMP: testTmpDir
}

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
    env: hermeticHomeEnv,
    include: ['src/**/*.test.ts']
  }
})
