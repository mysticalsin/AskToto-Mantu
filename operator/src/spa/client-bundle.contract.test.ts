import { describe, expect, it } from 'vitest'
import { buildClientBundle } from '../../scripts/build-client.mjs'
import { CONSOLE_JS, CONSOLE_JS_BUILT_FROM } from './client.generated'

describe('client bundle is not stale (#D3)', () => {
  it('committed client.generated.ts matches a fresh esbuild rebuild of operator/client/', async () => {
    const fresh = await buildClientBundle()
    expect(CONSOLE_JS_BUILT_FROM, 'run npm run build:operator-client').toBe(fresh.hash)
    expect(CONSOLE_JS, 'run npm run build:operator-client').toBe(fresh.code)
  }, 20000)
})
