import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Own config, same reason as cloudflare-proxy/: the root vitest include globs never
 * reach operator/. Chained from package.json `test` via `test:operator`.
 */
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
