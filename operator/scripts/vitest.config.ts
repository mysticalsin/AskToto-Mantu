import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    include: ['*.contract.test.ts']
  }
})
