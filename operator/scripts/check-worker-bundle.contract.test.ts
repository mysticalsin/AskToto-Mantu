import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { join } from 'node:path'
import { bundleEntry, containsMemoryStore, containsQaDashboardFixture } from './check-worker-bundle.mjs'

describe('check-worker-bundle', () => {
  it('the built Worker entry does not contain the in-memory store', async () => {
    const bundle = await bundleEntry('src/index.ts')
    expect(containsMemoryStore(bundle)).toBe(false)
    expect(containsQaDashboardFixture(bundle)).toBe(false)
  }, 60_000)

  it('detects the in-memory store when an entry does import it', async () => {
    const result = await build({
      stdin: {
        contents: "import { memoryStore } from './src/store'\nglobalThis.leak = memoryStore()",
        resolveDir: join(__dirname, '..'),
        loader: 'ts'
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    })
    expect(containsMemoryStore(result.outputFiles[0].text)).toBe(true)
  }, 60_000)

  it('detects the QA dashboard fixture when an entry does import it', async () => {
    const result = await build({
      stdin: {
        contents: "import { fixtureRows } from './test/fixtures/dashboard'\nglobalThis.leak = fixtureRows",
        resolveDir: join(__dirname, '..'),
        loader: 'ts'
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    })
    expect(containsQaDashboardFixture(result.outputFiles[0].text)).toBe(true)
  }, 60_000)
})
