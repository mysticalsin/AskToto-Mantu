import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/unused-in-tests' } }))
const machineIdentity = vi.hoisted(() => ({ durableId: 'machine-test-0001' as string | null }))
vi.mock('./license', () => ({ getDurableMachineId: () => machineIdentity.durableId }))
const auditLogMock = vi.fn()
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} },
  auditLog: (...args: unknown[]) => auditLogMock(...args)
}))

import {
  canonicalModelPolicyPayload,
  emptyModelPolicyEntry,
  MODEL_POLICY_CAPABILITIES,
  type ModelPolicyDocument
} from '@shared/model-policy'
import {
  getActiveModelPolicy,
  narrowAllowedForCapability,
  refreshModelPolicy,
  resetModelPolicyStateForTests,
  resolveManagedModel,
  setModelPolicyDirForTests,
  setModelPolicyFetchForTests
} from './model-policy-client'

const SETTINGS = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'shared-secret' }
const NOW = 1_725_000_000_000

function policy(overrides: Partial<ModelPolicyDocument['capabilities']> = {}): ModelPolicyDocument {
  const base = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, emptyModelPolicyEntry('anthropic', 'claude-sonnet-4-6')])
  ) as ModelPolicyDocument['capabilities']
  return { version: NOW, updatedAt: NOW, updatedBy: 'owner@example.test', capabilities: { ...base, ...overrides } }
}

function sign(secret: string, doc: ModelPolicyDocument): string {
  return createHmac('sha256', secret).update(canonicalModelPolicyPayload(doc)).digest('hex')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-policy-client-'))
  setModelPolicyDirForTests(dir)
  resetModelPolicyStateForTests()
  auditLogMock.mockClear()
  machineIdentity.durableId = 'machine-test-0001'
})

afterEach(() => {
  setModelPolicyFetchForTests(null)
  setModelPolicyDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('refreshModelPolicy / getActiveModelPolicy', () => {
  it('starts unmanaged (null) before any fetch', () => {
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
  })

  it('applies a verified, correctly signed policy', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('rejects a policy signed with the wrong secret, keeping the previous state, and audits it', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign('wrong-secret', doc) }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).toHaveBeenCalledWith('operator.model_policy.rejected', expect.objectContaining({ reason: 'signature' }))
  })

  it('rejects a tampered policy (model changed after signing) even though the signature field is present', async () => {
    const doc = policy()
    const signature = sign('shared-secret', doc)
    const tampered = { ...doc, capabilities: { ...doc.capabilities, askChat: { provider: 'openai', model: 'gpt-5', fallbacks: [] } } }
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: tampered, signature }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).toHaveBeenCalledWith('operator.model_policy.rejected', expect.objectContaining({ reason: 'signature' }))
  })

  it('rejects a schema-invalid document without applying it', async () => {
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: { version: 1 }, signature: 'a'.repeat(64) }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).toHaveBeenCalledWith('operator.model_policy.rejected', expect.objectContaining({ reason: 'schema' }))
  })

  it('treats policy:null as "not managed", not a rejection — no audit event', async () => {
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: null }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).not.toHaveBeenCalled()
  })

  it('a network failure leaves the last verified policy in place (offline use)', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) }))
    await refreshModelPolicy(SETTINGS, NOW)
    setModelPolicyFetchForTests(async () => {
      throw new Error('network down')
    })
    await refreshModelPolicy(SETTINGS, NOW + 60_000)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('caches the verified policy to disk and reloads it after a simulated relaunch', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) }))
    await refreshModelPolicy(SETTINGS, NOW)
    const cacheFile = readFileSync(join(dir, 'model-policy-cache.json'), 'utf8')
    expect(JSON.parse(cacheFile).policy.version).toBe(NOW)

    resetModelPolicyStateForTests() // simulate relaunch: in-memory state gone, disk cache remains
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('does not trust a disk cache signed for a different (rotated) secret', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) }))
    await refreshModelPolicy(SETTINGS, NOW)
    resetModelPolicyStateForTests()
    expect(getActiveModelPolicy({ ...SETTINGS, operatorIngestSecret: 'rotated-secret' })).toBeNull()
  })
})

describe('narrowAllowedForCapability / resolveManagedModel (thin wrappers over the shared pure module)', () => {
  it('with no policy, both are no-ops', () => {
    expect(narrowAllowedForCapability(SETTINGS, ['anthropic'], 'askChat')).toEqual(['anthropic'])
    expect(resolveManagedModel(SETTINGS, 'askChat', 'anthropic', 'my-model')).toBe('my-model')
  })

  it('once a policy is active, narrows providers and pins the model for the governed capability', async () => {
    const doc = policy({
      askChat: { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [{ provider: 'openai', model: 'gpt-5' }] }
    })
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(new Set(narrowAllowedForCapability(SETTINGS, null, 'askChat', ['claude-cli', 'local']))).toEqual(
      new Set(['anthropic', 'openai', 'claude-cli', 'local'])
    )
    expect(resolveManagedModel(SETTINGS, 'askChat', 'anthropic', 'whatever')).toBe('claude-sonnet-4-6')
    expect(resolveManagedModel(SETTINGS, 'askChat', 'claude-cli', 'whatever-the-cli-uses')).toBe('whatever-the-cli-uses')
  })
})
