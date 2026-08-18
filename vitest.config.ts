import { defineConfig, mergeConfig } from 'vitest/config'
import { resolve } from 'path'
import electronViteConfig from './electron.vite.config'

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
