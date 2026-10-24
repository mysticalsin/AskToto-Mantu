import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffloadReceipt } from '@shared/component-offload'
import type { OptionalComponentId, OptionalComponentStatus } from '@shared/speech-pack'
import { OPTIONAL_COMPONENT_DESCRIPTORS } from '../speech-pack/optional-component-descriptors'
import { createOffloadReceiptStore } from './receipts'
import { createComponentOffloadService, type OffloadTarget } from './service'
import { createLocalModelTarget } from './targets'

let userData: string
let modelsRoot: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'component-offload-'))
  modelsRoot = join(userData, 'local-llm', 'models')
  mkdirSync(join(modelsRoot, 'qwen3.5-0.8b'), { recursive: true })
  mkdirSync(join(modelsRoot, 'other-model'), { recursive: true })
  writeFileSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'), Buffer.alloc(1000))
  writeFileSync(join(modelsRoot, 'qwen3.5-0.8b', 'mmproj.gguf'), Buffer.alloc(500))
  writeFileSync(join(modelsRoot, 'other-model', 'model.gguf'), Buffer.alloc(300))
  mkdirSync(join(userData, 'meetings'), { recursive: true })
  mkdirSync(join(userData, 'brain'), { recursive: true })
  writeFileSync(join(userData, 'meetings', 'standup.md'), 'private meeting')
  writeFileSync(join(userData, 'brain', 'index.json'), '{}')
})
afterEach(() => rmSync(userData, { recursive: true, force: true }))

function status(id: OptionalComponentId, over: Partial<OptionalComponentStatus> = {}): OptionalComponentStatus {
  const descriptor = OPTIONAL_COMPONENT_DESCRIPTORS.find((item) => item.id === id)!
  return {
    id,
    label: descriptor.label,
    provider: descriptor.provider,
    sourceHost: descriptor.sourceHost,
    privacy: 'on-device',
    privacyNote: descriptor.privacyNote,
    downloadBytes: descriptor.downloadBytes,
    installedBytes: descriptor.installedBytes,
    presence: 'installed',
    blockedBy: null,
    failure: null,
    installable: false,
    removable: true,
    removableBytes: descriptor.installedBytes,
    offer: { surface: descriptor.offer.surface, consent: 'required' },
    ...over
  }
}

function localTarget(over: { downloading?: () => boolean; stopRuntime?: () => void } = {}) {
  return createLocalModelTarget({
    modelsRoot: () => modelsRoot,
    modelId: 'qwen3.5-0.8b',
    downloading: over.downloading ?? (() => false),
    stopRuntime: over.stopRuntime ?? (() => undefined)
  })
}

function setup(
  over: {
    statuses?: () => Promise<OptionalComponentStatus[]>
    capture?: () => boolean
    target?: OffloadTarget
    free?: number[]
    now?: () => number
  } = {}
) {
  const free = [...(over.free ?? [10_000, 11_500])]
  const target = over.target ?? localTarget()
  const receipts = createOffloadReceiptStore(join(userData, 'receipts.json'))
  const service = createComponentOffloadService({
    statuses: over.statuses ?? (async () => [status('local-llm')]),
    target: (id) => (id === 'local-llm' ? target : null),
    captureActive: over.capture ?? (() => false),
    freeBytes: async () => free.shift() ?? null,
    receipts,
    now: over.now ?? (() => 1_000_000),
    newId: () => randomUUID()
  })
  return { service, receipts }
}

async function preview(service: ReturnType<typeof setup>['service']) {
  const result = await service.preview({ componentId: 'local-llm' })
  if (!result.ok) throw new Error(`preview refused: ${result.reason}`)
  return result.plan
}

describe('component offload service (G87)', () => {
  it('preview then confirm removes files and returns a measured receipt', async () => {
    const { service, receipts } = setup()
    const plan = await preview(service)
    expect(plan).toMatchObject({ componentId: 'local-llm', degradesTo: 'cloud-llm' })
    // Preview has no side effect.
    expect(existsSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'))).toBe(true)

    const result = await service.confirm({ planId: plan.planId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt).toMatchObject({
      componentId: 'local-llm',
      bytesFreed: 1500,
      freeBytesBefore: 10_000,
      freeBytesAfter: 11_500,
      verifiedAbsent: true,
      sessionDataTouched: false
    })
    expect(existsSync(join(modelsRoot, 'qwen3.5-0.8b'))).toBe(false)
    expect(await receipts.list()).toEqual([result.receipt])
    expect(await service.receipts()).toEqual([result.receipt])
  })

  it('refuses during capture, at preview and at confirm, and removes nothing', async () => {
    let capturing = true
    const { service } = setup({ capture: () => capturing })
    expect(await service.preview({ componentId: 'local-llm' })).toEqual({ ok: false, reason: 'capture-active' })
    capturing = false
    const plan = await preview(service)
    capturing = true
    expect(await service.confirm({ planId: plan.planId })).toEqual({ ok: false, reason: 'capture-active' })
    expect(existsSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'))).toBe(true)
  })

  it('refuses bundled, absent and non-removable components', async () => {
    const cases: Array<[Partial<OptionalComponentStatus>, string]> = [
      [{ presence: 'bundled', removable: false }, 'bundled'],
      [{ presence: 'absent', removable: false }, 'absent'],
      [{ removable: false }, 'not-removable']
    ]
    for (const [over, reason] of cases) {
      const { service } = setup({ statuses: async () => [status('local-llm', over)] })
      expect(await service.preview({ componentId: 'local-llm' })).toEqual({ ok: false, reason })
    }
    expect(existsSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'))).toBe(true)
  })

  it('refuses while the local model is downloading', async () => {
    const { service } = setup({ target: localTarget({ downloading: () => true }) })
    expect(await service.preview({ componentId: 'local-llm' })).toEqual({ ok: false, reason: 'busy' })
  })

  it('a plan is single-use and expires', async () => {
    let now = 1_000_000
    const { service } = setup({ now: () => now, free: [1, 2, 3, 4] })
    const first = await preview(service)
    expect((await service.confirm({ planId: first.planId })).ok).toBe(true)
    expect(await service.confirm({ planId: first.planId })).toEqual({ ok: false, reason: 'plan-expired' })

    mkdirSync(join(modelsRoot, 'qwen3.5-0.8b'), { recursive: true })
    writeFileSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'), Buffer.alloc(10))
    const second = await preview(service)
    now += 2 * 60_000 + 1
    expect(await service.confirm({ planId: second.planId })).toEqual({ ok: false, reason: 'plan-expired' })
    expect(existsSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'))).toBe(true)
  })

  it('re-checks guards at confirm', async () => {
    let downloading = false
    let current: Partial<OptionalComponentStatus> = {}
    const { service } = setup({
      target: localTarget({ downloading: () => downloading }),
      statuses: async () => [status('local-llm', current)]
    })
    const busyPlan = await preview(service)
    downloading = true
    expect(await service.confirm({ planId: busyPlan.planId })).toEqual({ ok: false, reason: 'busy' })
    downloading = false
    const gonePlan = await preview(service)
    current = { presence: 'absent', removable: false }
    expect(await service.confirm({ planId: gonePlan.planId })).toEqual({ ok: false, reason: 'absent' })
    current = {}
    const stalePlan = await preview(service)
    current = { presence: 'model-only' }
    expect(await service.confirm({ planId: stalePlan.planId })).toEqual({ ok: false, reason: 'stale-plan' })
    expect(existsSync(join(modelsRoot, 'qwen3.5-0.8b', 'model.gguf'))).toBe(true)
  })

  it('rejects malformed requests without side effects', async () => {
    const { service } = setup()
    expect(await service.preview({ componentId: '../../meetings' })).toEqual({ ok: false, reason: 'invalid-request' })
    expect(await service.preview({ componentId: 'local-llm', path: '/etc' })).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    expect(await service.confirm({ planId: 'nope' })).toEqual({ ok: false, reason: 'invalid-request' })
    expect(await service.confirm(undefined)).toEqual({ ok: false, reason: 'invalid-request' })
  })

  it('never touches meetings, brain or sibling userData entries', async () => {
    const stop = vi.fn()
    const { service } = setup({ target: localTarget({ stopRuntime: stop }) })
    const plan = await preview(service)
    expect((await service.confirm({ planId: plan.planId })).ok).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(userData, 'meetings', 'standup.md'), 'utf8')).toBe('private meeting')
    expect(readFileSync(join(userData, 'brain', 'index.json'), 'utf8')).toBe('{}')
    expect(readdirSync(modelsRoot)).toEqual(['other-model'])
    expect(readFileSync(join(modelsRoot, 'other-model', 'model.gguf')).length).toBe(300)
  })

  it('the receipt carries no absolute path', async () => {
    const { service, receipts } = setup()
    const plan = await preview(service)
    const result = await service.confirm({ planId: plan.planId })
    const serialized = JSON.stringify(result) + readFileSync(join(userData, 'receipts.json'), 'utf8')
    expect(serialized).not.toContain(userData)
    expect(serialized).not.toContain(homedir())
    expect(serialized).not.toMatch(/[\\/]Users[\\/]|[A-Za-z]:\\\\/)
    expect((await receipts.list())[0]).not.toHaveProperty('path')
  })

  it('keeps only the last 20 receipts, newest first', async () => {
    const store = createOffloadReceiptStore(join(userData, 'bounded.json'))
    const make = (i: number): OffloadReceipt => ({
      receiptId: randomUUID(),
      componentId: 'whisper',
      label: 'Whisper (offline speech)',
      removedAt: new Date(1_000_000 + i).toISOString(),
      bytesFreed: i,
      freeBytesBefore: null,
      freeBytesAfter: null,
      verifiedAbsent: true,
      sessionDataTouched: false
    })
    for (let i = 0; i < 25; i++) await store.append(make(i))
    const list = await store.list()
    expect(list).toHaveLength(20)
    expect(list[0]?.bytesFreed).toBe(24)
    expect(list[19]?.bytesFreed).toBe(5)
  })

  it('reads a corrupt receipt file as empty and keeps working', async () => {
    writeFileSync(join(userData, 'receipts.json'), '{not json')
    const { service } = setup()
    expect(await service.receipts()).toEqual([])
    const plan = await preview(service)
    expect((await service.confirm({ planId: plan.planId })).ok).toBe(true)
    expect(await service.receipts()).toHaveLength(1)
  })

  it('startup sweep removes an interrupted offload leftover', async () => {
    mkdirSync(join(modelsRoot, '.evict-abc'), { recursive: true })
    writeFileSync(join(modelsRoot, '.evict-abc', 'model.gguf'), Buffer.alloc(5))
    const { service } = setup()
    await service.initialise()
    expect(readdirSync(modelsRoot).sort()).toEqual(['other-model', 'qwen3.5-0.8b'])
  })

  it('reports a failed removal honestly and writes no receipt', async () => {
    const failing: OffloadTarget = {
      busy: () => false,
      evict: async () => ({ ok: false, reason: 'failed' }),
      verifyAbsent: async () => false,
      sweep: async () => undefined
    }
    const { service, receipts } = setup({ target: failing })
    const plan = await preview(service)
    expect(await service.confirm({ planId: plan.planId })).toEqual({ ok: false, reason: 'failed' })
    expect(await receipts.list()).toEqual([])
  })
})
