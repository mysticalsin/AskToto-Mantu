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
