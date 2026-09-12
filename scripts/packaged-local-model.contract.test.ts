import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const require = createRequire(import.meta.url)
const { getConfig } = require('app-builder-lib/out/util/config/config.js') as {
  getConfig: (root: string, path: string, overrides?: object) => Promise<{
    extraResources: Array<{ from: string; to: string; filter?: string[] }>
  }>
}
const source = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')

describe('MQA-319: the default local model is self-contained in every Electron installer', () => {
  it.each(['electron-builder.yml', 'electron-builder.win.yml', 'electron-builder.cahe.win.yml'])(
    '%s includes exactly the compact model pair and license through real config inheritance',
    async (file) => {
      const config = await getConfig(root, file)
      const local = config.extraResources.filter((entry) => entry.to?.startsWith('local-llm/'))
      expect(local).toEqual([
        {
          from: 'resources/local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt',
          to: 'local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt'
        },
        {
          from: 'resources/local-llm/models',
          to: 'local-llm/models',
          filter: ['qwen3.5-0.8b/model.gguf', 'qwen3.5-0.8b/mmproj.gguf']
        }
      ])
    }
  )

  it('checks the same exact immutable model inventory before and after signing', () => {
    const gate = source('scripts/check-packaged-runtime.mjs')
    expect(gate).toContain("import { verifyLocalModelPayload } from './lib/local-model-inventory.mjs'")
    expect(gate).toMatch(/await verifyLocalModelPayload\(join\(resourcesRoot, 'local-llm'\)\)/)
    expect(gate).not.toMatch(/if\s*\([^)]*postSign[^)]*\)\s*(?:\{\s*)?await verifyLocalModelPayload/)
  })

  it('does not weaken the existing artifact cap to accommodate model weights', () => {
    const gate = source('scripts/check-release.mjs')
    expect(gate).toContain('const ARTIFACT_FAIL_BYTES = 1.9 * GIB')
    expect(gate).toContain('if (size >= ARTIFACT_FAIL_BYTES)')
  })
})
