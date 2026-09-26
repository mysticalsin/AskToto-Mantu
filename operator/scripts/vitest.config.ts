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
const testHome = mkdtempSync(join(tmpdir(), 'metis-test-home-opscripts-'))
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
 * Own config, same reason as operator/vitest.config.ts and cloudflare-proxy/vitest.config.ts:
 * neither the root config's include globs (src/, intelligence/src/, scripts/, eval/ at the repo
 * root) nor operator/vitest.config.ts's (src/**\/*.test.ts under operator/) reach
 * operator/scripts/. These are plain Node build/ops scripts (deploy, smoke, backup, dev-session),
 * not Worker source, so they get their own small config rather than being folded into either.
 *
 *   npx vitest run --config operator/scripts/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    environment: 'node',
    env: hermeticHomeEnv,
    include: ['*.contract.test.ts']
  }
})
