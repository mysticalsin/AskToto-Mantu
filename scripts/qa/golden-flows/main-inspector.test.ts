import inspector from 'node:inspector'
import v8 from 'node:v8'
import vm from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectorClient } from './right-edge-hide-rows.mjs'

describe('inspectorClient', () => {
  let client: Awaited<ReturnType<typeof inspectorClient>> | null = null

  beforeAll(async () => {
    v8.setFlagsFromString('--expose-gc')
    ;(globalThis as Record<string, unknown>).__metisInspectorTestGc = vm.runInNewContext('gc')
    inspector.open(0, '127.0.0.1')
    const wsUrl = inspector.url()
    if (!wsUrl) throw new Error('test worker inspector did not open')
    client = await inspectorClient(wsUrl)
  })

  afterAll(async () => {
    delete (globalThis as Record<string, unknown>).__metisInspectorTestGc
    await client?.close()
    client = null
    inspector.close()
  })

  it('does not await collected wrappers for synchronous values', async () => {
    if (!client) throw new Error('inspector client did not initialize')
    for (let i = 0; i < 10; i++) {
      await expect(
        client.evaluate('queueMicrotask(() => globalThis.__metisInspectorTestGc()); ({ ok: true })')
      ).resolves.toEqual({ ok: true })
    }
  })
})
