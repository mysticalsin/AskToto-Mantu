import { defineConfig, mergeConfig } from 'vitest/config'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'path'
import electronViteConfig from './electron.vite.config'

// W0-HERMETIC / MQA-348 — every test worker gets a fresh, empty home directory. Production code derives
// real user locations from the home directory (detectOneDrive → ~/Library/CloudStorage/OneDrive-*, then
// the one-time "AskToto Meetings" copy-forward into "Métis Meetings"), so a test that never pins a
// meetings folder was reading and WRITING the developer's real OneDrive meeting store. Under the sandbox
// the write failed silently; unsandboxed, copyFileSync blocked on a cloud-only placeholder and hung the
// worker forever (a synchronous block starves testTimeout, so the run never ended). CI has no OneDrive,
// which is why it never showed there. A throwaway home per run makes every test resolve the same
// no-OneDrive path CI sees, and nothing a test does can reach a real profile — even a HOME the calling
// shell or CI environment already set is overridden here, since Vitest's `test.env` wins over inherited
// process env for the worker.
//
// Playwright resolves its browser cache from the home directory too, so pin it to the REAL cache (unless
// the caller already chose one) or the browser-backed tests would lose their Chromium. `homedir()` here
// runs in the config-loading process, before any override below applies, so it still resolves the actual
// developer home.
function playwrightBrowsersPath(realHome: string): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  if (process.platform === 'darwin') return join(realHome, 'Library', 'Caches', 'ms-playwright')
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(realHome, 'AppData', 'Local'), 'ms-playwright')
  }
  return join(process.env.XDG_CACHE_HOME || join(realHome, '.cache'), 'ms-playwright')
}
const testHome = mkdtempSync(join(tmpdir(), 'metis-test-home-'))
// A handful of existing tests already do mkdtempSync(join(tmpdir(), 'asktoto-...')) — once TMPDIR below
// is honored by os.tmpdir(), those land inside the sandbox home too, so create it up front.
const testTmpDir = join(testHome, 'tmp')
mkdirSync(testTmpDir, { recursive: true })
const hermeticHomeEnv = {
  HOME: testHome,
  USERPROFILE: testHome,
  // Windows detectOneDrive() trusts these before the home directory; empty means "no OneDrive".
  OneDrive: '',
  OneDriveCommercial: '',
  OneDriveConsumer: '',
  APPDATA: join(testHome, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(testHome, 'AppData', 'Local'),
  TMPDIR: testTmpDir,
  TMP: testTmpDir,
  TEMP: testTmpDir,
  PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(homedir()),
  METIS_TEST_HOME: testHome,
  // Unique per run/worktree — __mocks__/electron.ts derives every app.getPath(...) answer from this, so
  // a concurrent run (another worktree, a parallel agent) never shares a userData/documents path with us.
  ASKTOTO_TEST_SANDBOX_ROOT: testHome
}

// A `#!/usr/bin/env node` shebang is valid in a file Node's own loader reads directly, but esbuild's
// transform (which Vitest runs on served modules) PRESERVES it, and Vitest then evaluates the
// transformed source as a module — where a leading `#!` is an "Invalid or unexpected token".
// prove-local-ttft.systemPrompt.test.ts statically imports scripts/prove-local-ttft.mjs, which keeps
// its shebang (repo convention, matches its sibling scripts, allows `./script` on Unix). Strip a
// leading shebang before transform so such imports parse. Only ever touches files literally starting
// with `#!`; blank line keeps subsequent line numbers aligned for stack traces / sourcemaps.
const stripShebangPlugin = {
  name: 'asktoto:strip-shebang',
  enforce: 'pre' as const,
  transform(code: string) {
    if (!code.startsWith('#!')) return null
    return { code: code.replace(/^#![^\n]*/, ''), map: null }
  }
}

const vitestConfig = defineConfig({
  plugins: [stripShebangPlugin],
  // Match the renderer's react-jsx compiler setting explicitly. The root config only references
  // tsconfig.web.json, so Vite's standalone test transform does not inherit that JSX option.
  esbuild: { jsx: 'automatic' },
  test: {
    globals: true,
    environment: 'node',
    // Also covers intelligence/ (the standalone dashboard sub-project) — its lib/ files are pure TS
    // with no DOM dependency at module-load time, so the shared node environment above is fine for them.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'intelligence/src/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.{test,spec}.{ts,tsx}',
      'eval/**/*.{test,spec}.{ts,tsx}'
    ],
    // MQA-007 — a run's verdict must not depend on what else the machine is doing.
    //
    // Vitest's 5s default is sized for pure in-memory unit tests. A large part of this suite is not
    // that: the brain tests stand up a real temp profile, ingest through the real queue/pump/merge, and
    // write index.json and every entity file through the production tmp+rename durability path, on a
    // Windows checkout that is routinely under OneDrive/AV. Serially those tests finish in well under a
    // second; with several vitest processes competing for the same disk (a multi-agent QA sweep, or a
    // developer running two suites at once) the same correct code crosses 5s and the run goes red — in
    // whichever file happened to be scheduled worst, which is why it never reproduced twice the same way.
    //
    // Raising the budget does not weaken the gate: a genuinely hung test still fails, just later. What it
    // removes is the class of failure that reports a scheduling accident as a defect — the thing that
    // erodes trust in a green suite, and that this repo has a documented history of using to mask real
    // failures. The individual `vi.waitFor` call sites carry their own explicit budgets for the same
    // reason; this is the floor under the ones that do not.
    // 30s is where measurement put it, not a guess: the heaviest cases here (corrections' rebuild+replay
    // convergence proofs, brain's 6-permutation determinism proof) finish in well under a second serially
    // and crossed 20s only once ~10 vitest processes were competing for one disk. One lever rather than a
    // scatter of per-test magic numbers.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: hermeticHomeEnv,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**/*', 'src/shared/**/*', 'src/preload/**/*']
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})

export default mergeConfig(electronViteConfig, vitestConfig)
