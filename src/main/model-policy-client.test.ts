import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
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
  canonicalUnmanagedModelPolicyPayload,
  emptyModelPolicyEntry,
  MODEL_POLICY_CAPABILITIES,
  type ModelPolicyDocument
} from '@shared/model-policy'
import {
  getActiveModelPolicy,
  getVerifiedSpeechPolicySnapshot,
  invalidateSpeechPolicyProof,
  narrowAllowedForCapability,
  refreshModelPolicy,
  refreshModelPolicyChecked,
  resetModelPolicyStateForTests,
  resolveLocalSpeechPackPolicy,
  resolveManagedModel,
  setModelPolicyDirForTests,
  setModelPolicyFetchForTests,
  setSpeechPolicyClockForTests,
  setSpeechPolicyIdentityReader,
  setSpeechPolicyProofRevocationListener
} from './model-policy-client'

const SETTINGS = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'shared-secret' }
const NOW = 1_725_000_000_000
const LICENSE_NOW = Date.now()
const SPEECH_TOKEN = `METIS-OP-1.0123456789abcdef.${Math.floor(LICENSE_NOW / 1000) - 60}.${Math.floor(LICENSE_NOW / 1000) + 3600}.AAAAAAAAAAAAAAAAAAAA`
const SPEECH_SETTINGS = { operatorUrl: 'https://operator.test', operatorLicenseToken: SPEECH_TOKEN }
const MACHINE_ID = 'machine-test-0001'

function policy(
  overrides: Partial<ModelPolicyDocument['capabilities']> = {},
  localSpeechPack: ModelPolicyDocument['localSpeechPack'] = 'offered'
): ModelPolicyDocument {
  const base = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, emptyModelPolicyEntry('anthropic', 'claude-sonnet-4-6')])
  ) as ModelPolicyDocument['capabilities']
  return {
    version: NOW,
    updatedAt: NOW,
    updatedBy: 'owner@example.test',
    localSpeechPack,
    capabilities: { ...base, ...overrides }
  }
}

function sign(secret: string, doc: ModelPolicyDocument): string {
  return createHmac('sha256', secret).update(canonicalModelPolicyPayload(doc)).digest('hex')
}

function signedUnmanaged(issuedAt: number, secret = 'shared-secret'): unknown {
  const signature = createHmac('sha256', secret).update(canonicalUnmanagedModelPolicyPayload(issuedAt)).digest('hex')
  return { ok: true, policy: null, issuedAt, signature }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-policy-client-'))
  setModelPolicyDirForTests(dir)
  resetModelPolicyStateForTests()
  setSpeechPolicyClockForTests(() => LICENSE_NOW)
  auditLogMock.mockClear()
  machineIdentity.durableId = 'machine-test-0001'
})

afterEach(() => {
  setModelPolicyFetchForTests(null)
  setModelPolicyDirForTests(null)
  setSpeechPolicyIdentityReader(null)
  setSpeechPolicyClockForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

function useSpeechIdentity(settings = SPEECH_SETTINGS, durableDeviceId: string | null = MACHINE_ID): void {
  setSpeechPolicyIdentityReader(() => ({ settings, durableDeviceId }))
}

describe('refreshModelPolicy / getActiveModelPolicy', () => {
  it('starts unmanaged (null) before any fetch', () => {
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
  })

  it('applies a verified, correctly signed policy', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('reports a change only when the effective policy changed, never on an idle poll', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    expect(await refreshModelPolicy(SETTINGS, NOW)).toBe(true)
    expect(await refreshModelPolicy(SETTINGS, NOW + 30_000)).toBe(false)
  })

  it('rejects a policy signed with the wrong secret, keeping the previous state, and audits it', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('wrong-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).toHaveBeenCalledWith(
      'operator.model_policy.rejected',
      expect.objectContaining({ reason: 'signature' })
    )
  })

  it('rejects a tampered policy (model changed after signing) even though the signature field is present', async () => {
    const doc = policy()
    const signature = sign('shared-secret', doc)
    const tampered = {
      ...doc,
      capabilities: { ...doc.capabilities, askChat: { provider: 'openai', model: 'gpt-5', fallbacks: [] } }
    }
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: tampered, signature }))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).toHaveBeenCalledWith(
      'operator.model_policy.rejected',
      expect.objectContaining({ reason: 'signature' })
    )
  })

  it('rejects a schema-invalid document without applying it', async () => {
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: { version: 1 }, signature: 'a'.repeat(64) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).toHaveBeenCalledWith(
      'operator.model_policy.rejected',
      expect.objectContaining({ reason: 'schema' })
    )
  })

  it('treats a signed policy:null as "not managed", not a rejection — no audit event', async () => {
    setModelPolicyFetchForTests(async () => jsonResponse(signedUnmanaged(NOW)))
    await refreshModelPolicy(SETTINGS, NOW)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
    expect(auditLogMock).not.toHaveBeenCalled()
  })

  it('an unsigned policy:null keeps the verified cached policy and audits the rejection', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: null }))
    await refreshModelPolicy(SETTINGS, NOW + 60_000)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
    resetModelPolicyStateForTests() // the disk cache survived too
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
    expect(auditLogMock).toHaveBeenCalledWith(
      'operator.model_policy.rejected',
      expect.objectContaining({ reason: 'unmanaged-signature' })
    )
  })

  it('a policy:null signed with the wrong secret keeps the cached policy', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    setModelPolicyFetchForTests(async () => jsonResponse(signedUnmanaged(NOW + 60_000, 'wrong-secret')))
    await refreshModelPolicy(SETTINGS, NOW + 60_000)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('a replayed signed policy:null older than the cached policy cannot clear it, a newer one does', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    setModelPolicyFetchForTests(async () => jsonResponse(signedUnmanaged(NOW - 1)))
    await refreshModelPolicy(SETTINGS, NOW + 60_000)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
    setModelPolicyFetchForTests(async () => jsonResponse(signedUnmanaged(NOW + 120_000)))
    await refreshModelPolicy(SETTINGS, NOW + 120_000)
    expect(getActiveModelPolicy(SETTINGS)).toBeNull()
  })

  it('a network failure leaves the last verified policy in place (offline use)', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    setModelPolicyFetchForTests(async () => {
      throw new Error('network down')
    })
    await refreshModelPolicy(SETTINGS, NOW + 60_000)
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('caches the verified policy to disk and reloads it after a simulated relaunch', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    const cacheFile = readFileSync(join(dir, 'model-policy-cache.json'), 'utf8')
    expect(JSON.parse(cacheFile).policy.version).toBe(NOW)

    resetModelPolicyStateForTests() // simulate relaunch: in-memory state gone, disk cache remains
    expect(getActiveModelPolicy(SETTINGS)?.version).toBe(NOW)
  })

  it('does not trust a disk cache signed for a different (rotated) secret', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    resetModelPolicyStateForTests()
    expect(getActiveModelPolicy({ ...SETTINGS, operatorIngestSecret: 'rotated-secret' })).toBeNull()
  })

  it('drops the in-memory legacy policy when its credential rotates without a relaunch', async () => {
    const doc = policy()
    const original = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'original-secret' }
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('original-secret', doc) })
    )
    await refreshModelPolicy(original, NOW)
    expect(getActiveModelPolicy(original)?.version).toBe(NOW)
    expect(getActiveModelPolicy({ ...original, operatorIngestSecret: 'rotated-secret' })).toBeNull()
  })

  it('does not retain an in-memory legacy policy after the Operator origin changes', async () => {
    const doc = policy()
    const original = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'same-secret' }
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('same-secret', doc) })
    )
    await refreshModelPolicy(original, NOW)
    expect(getActiveModelPolicy(original)?.version).toBe(NOW)
    rmSync(join(dir, 'model-policy-cache.json'), { force: true })
    expect(getActiveModelPolicy({ ...original, operatorUrl: 'https://replacement.test' })).toBeNull()
  })
})

describe('verified speech policy authority', () => {
  it('is closed without the main-owned current identity reader', async () => {
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('returns a scoped snapshot only for the current device licence, origin, device and freshness window', async () => {
    useSpeechIdentity()
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    const snapshot = getVerifiedSpeechPolicySnapshot()
    expect(snapshot).toMatchObject({
      origin: 'https://operator.test',
      credentialDigest: createHash('sha256').update(SPEECH_TOKEN, 'utf8').digest('hex'),
      deviceIdHash: expect.any(String),
      policy: doc
    })
    expect(snapshot?.verifiedAt).toEqual(expect.any(Number))
    expect(snapshot?.revision).toEqual(expect.any(String))
    setSpeechPolicyClockForTests(() => snapshot!.verifiedAt + 60_000)
    expect(getVerifiedSpeechPolicySnapshot()).toEqual(snapshot)
    setSpeechPolicyClockForTests(() => snapshot!.verifiedAt + 60_001)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    setSpeechPolicyClockForTests(() => snapshot!.verifiedAt - 1)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    setSpeechPolicyClockForTests(() => LICENSE_NOW)

    setSpeechPolicyIdentityReader(() => ({
      settings: { ...SPEECH_SETTINGS, operatorUrl: 'https://replacement.test' },
      durableDeviceId: MACHINE_ID
    }))
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    useSpeechIdentity({ ...SPEECH_SETTINGS, operatorLicenseToken: `${SPEECH_TOKEN}x` })
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    useSpeechIdentity(SPEECH_SETTINGS, null)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('refuses malformed, expired, future-issued and fleet-secret-only identities', async () => {
    useSpeechIdentity()
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()

    const nowSeconds = Math.floor(Date.now() / 1000)
    const invalidSettings = [
      { ...SPEECH_SETTINGS, operatorLicenseToken: 'METIS-OP-1.invalid' },
      {
        ...SPEECH_SETTINGS,
        operatorLicenseToken: `METIS-OP-1.2123456789abcdef.-1.${nowSeconds + 3600}.CCCCCCCCCCCCCCCCCCCC`
      },
      {
        ...SPEECH_SETTINGS,
        operatorLicenseToken: `METIS-OP-1.3123456789abcdef.${nowSeconds + 3600}.${nowSeconds + 7200}.DDDDDDDDDDDDDDDDDDDD`
      },
      { operatorUrl: SPEECH_SETTINGS.operatorUrl, operatorIngestSecret: 'fleet-secret-only' }
    ]
    for (const settings of invalidSettings) {
      setSpeechPolicyIdentityReader(() => ({ settings, durableDeviceId: MACHINE_ID }))
      expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    }
  })

  it('does not create verified authority from a disk cache after simulated relaunch', async () => {
    const doc = policy()
    useSpeechIdentity()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    resetModelPolicyStateForTests()
    useSpeechIdentity()
    expect(getActiveModelPolicy(SPEECH_SETTINGS)?.version).toBe(NOW)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('keeps freshness at the last real verification when a later network refresh fails', async () => {
    useSpeechIdentity()
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    setModelPolicyFetchForTests(async () => {
      throw new Error('network unavailable')
    })
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    const snapshot = getVerifiedSpeechPolicySnapshot()
    expect(snapshot).not.toBeNull()
    setSpeechPolicyClockForTests(() => snapshot!.verifiedAt + 59_999)
    expect(getVerifiedSpeechPolicySnapshot()?.verifiedAt).toBe(snapshot!.verifiedAt)
    setSpeechPolicyClockForTests(() => snapshot!.verifiedAt + 60_001)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('does not notify runtime revocation for transport failure or an identical proof refresh', async () => {
    useSpeechIdentity()
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    const firstVerifiedAt = getVerifiedSpeechPolicySnapshot()?.verifiedAt
    expect(firstVerifiedAt).toEqual(expect.any(Number))

    setSpeechPolicyClockForTests(() => firstVerifiedAt! + 10)
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()?.verifiedAt).toBe(firstVerifiedAt! + 10)
    expect(events).toEqual([])

    setModelPolicyFetchForTests(async () => {
      throw new Error('temporary network failure')
    })
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()
    expect(events).toEqual([])
  })

  it('notifies an idle owner on same-version explicit denial and on a real policy revision change', async () => {
    useSpeechIdentity()
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(events).toEqual([])

    const changed = { ...doc, version: NOW + 1, updatedAt: NOW + 1, updatedBy: 'changed-owner' }
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: changed, signature: sign(SPEECH_TOKEN, changed) })
    )
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(events).toEqual([{ kind: 'changed', reason: 'policy-changed' }])
    expect(getVerifiedSpeechPolicySnapshot()?.policy.updatedBy).toBe('changed-owner')

    setModelPolicyFetchForTests(async () => new Response('denied', { status: 401 }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(getActiveModelPolicy(SPEECH_SETTINGS)?.version).toBe(NOW + 1)
    expect(events).toEqual([
      { kind: 'changed', reason: 'policy-changed' },
      { kind: 'revoked', reason: 'http-denied' }
    ])
  })

  it('does not allow a held success to restore a proof after same-scope HTTP denial', async () => {
    useSpeechIdentity()
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()

    let resolveHeld!: (response: Response) => void
    const heldResponse = new Promise<Response>((resolve) => {
      resolveHeld = resolve
    })
    setModelPolicyFetchForTests(async () => heldResponse)
    const heldRefresh = refreshModelPolicyChecked(SPEECH_SETTINGS)

    setModelPolicyFetchForTests(async () => new Response('denied', { status: 403 }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(events).toEqual([{ kind: 'revoked', reason: 'http-denied' }])

    resolveHeld(jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await heldRefresh
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(events).toEqual([{ kind: 'revoked', reason: 'http-denied' }])
  })

  it('hard-revokes A across A-to-B-to-A settings reuse and rejects a held pre-revocation fetch', async () => {
    let live = { settings: SPEECH_SETTINGS, durableDeviceId: MACHINE_ID as string | null }
    setSpeechPolicyIdentityReader(() => live)
    let now = LICENSE_NOW
    setSpeechPolicyClockForTests(() => now)
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()

    let resolveHeld!: (response: Response) => void
    const heldResponse = new Promise<Response>((resolve) => {
      resolveHeld = resolve
    })
    setModelPolicyFetchForTests(async () => heldResponse)
    now += 10
    const heldRefresh = refreshModelPolicyChecked(SPEECH_SETTINGS)

    const tokenNow = Math.floor(LICENSE_NOW / 1000)
    const otherToken = `METIS-OP-1.1123456789abcdef.${tokenNow - 60}.${tokenNow + 3600}.BBBBBBBBBBBBBBBBBBBB`
    const otherSettings = { operatorUrl: 'https://operator.test', operatorLicenseToken: otherToken }
    live = { settings: otherSettings, durableDeviceId: MACHINE_ID }
    invalidateSpeechPolicyProof()
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(getActiveModelPolicy(SPEECH_SETTINGS)?.version).toBe(NOW)
    expect(events).toEqual([{ kind: 'revoked', reason: 'explicit-invalidation' }])

    live = { settings: SPEECH_SETTINGS, durableDeviceId: MACHINE_ID }
    now += 10
    const lower = { ...doc, version: NOW - 1, updatedAt: NOW - 1 }
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: lower, signature: sign(SPEECH_TOKEN, lower) })
    )
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()

    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    const newVerifiedAt = getVerifiedSpeechPolicySnapshot()?.verifiedAt
    expect(newVerifiedAt).toBe(now)

    now += 10
    resolveHeld(jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await heldRefresh
    expect(getVerifiedSpeechPolicySnapshot()?.verifiedAt).toBe(newVerifiedAt)
    expect(events).toEqual([{ kind: 'revoked', reason: 'explicit-invalidation' }])
  })

  it('clears speech authority on a signed unmanaged response', async () => {
    useSpeechIdentity()
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()
    setModelPolicyFetchForTests(async () => jsonResponse(signedUnmanaged(NOW + 1, SPEECH_TOKEN)))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(events).toEqual([{ kind: 'revoked', reason: 'signed-unmanaged' }])
  })

  it('does not extend authority after malformed or unsigned policy responses', async () => {
    useSpeechIdentity()
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: { version: 1 } }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(events).toEqual([{ kind: 'revoked', reason: 'invalid-response' }])

    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()
    setModelPolicyFetchForTests(async () => jsonResponse(null))
    await expect(refreshModelPolicyChecked(SPEECH_SETTINGS)).resolves.toMatchObject({ ok: false })
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(events).toEqual([
      { kind: 'revoked', reason: 'invalid-response' },
      { kind: 'revoked', reason: 'invalid-response' }
    ])
  })

  it.each([401, 403])('clears speech authority after an explicit HTTP %s rejection', async (status) => {
    useSpeechIdentity()
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()

    setModelPolicyFetchForTests(async () => new Response('denied', { status }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('clears speech authority as soon as denied response headers arrive, without waiting for its body', async () => {
    useSpeechIdentity()
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()

    const stalledBody = new ReadableStream<Uint8Array>({ start() {} })
    setModelPolicyFetchForTests(async () => new Response(stalledBody, { status: 401 }))
    await expect(refreshModelPolicyChecked(SPEECH_SETTINGS)).resolves.toMatchObject({ ok: false })
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('rejects oversized policy response bodies before JSON parsing and clears speech authority', async () => {
    useSpeechIdentity()
    const doc = policy()
    setModelPolicyFetchForTests(async () => jsonResponse({ ok: true, policy: doc, signature: sign(SPEECH_TOKEN, doc) }))
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).not.toBeNull()

    const oversized = new Response(new Uint8Array(65_537).fill(0x20), { status: 200 })
    setModelPolicyFetchForTests(async () => oversized)
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
  })

  it('rejects contradictory same-version policy content and retains a monotonic version high-water mark', async () => {
    useSpeechIdentity()
    const events: unknown[] = []
    setSpeechPolicyProofRevocationListener((event) => events.push(event))
    const current = policy()
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: current, signature: sign(SPEECH_TOKEN, current) })
    )
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()?.policy.updatedBy).toBe(current.updatedBy)

    const lower = { ...policy(), version: NOW - 1, updatedAt: NOW - 1 }
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: lower, signature: sign(SPEECH_TOKEN, lower) })
    )
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()?.policy.version).toBe(NOW)

    const conflict = { ...current, updatedBy: 'different-owner' }
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: conflict, signature: sign(SPEECH_TOKEN, conflict) })
    )
    await refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(getVerifiedSpeechPolicySnapshot()).toBeNull()
    expect(events).toEqual([{ kind: 'revoked', reason: 'policy-conflict' }])
  })

  it('does not let an older in-flight response overwrite a newly observed identity policy', async () => {
    let live = { settings: SPEECH_SETTINGS, durableDeviceId: MACHINE_ID as string | null }
    setSpeechPolicyIdentityReader(() => live)
    const oldPolicy = { ...policy(), updatedBy: 'old-scope' }
    const tokenNow = Math.floor(Date.now() / 1000)
    const newToken = `METIS-OP-1.1123456789abcdef.${tokenNow - 60}.${tokenNow + 3600}.BBBBBBBBBBBBBBBBBBBB`
    const newSettings = { operatorUrl: 'https://operator.test', operatorLicenseToken: newToken }
    const newPolicy = { ...policy(), updatedBy: 'new-scope' }
    let resolveOld!: (response: Response) => void
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => oldResponse)
      .mockImplementationOnce(async () =>
        jsonResponse({ ok: true, policy: newPolicy, signature: sign(newToken, newPolicy) })
      )
    setModelPolicyFetchForTests(fetchMock)

    const oldRefresh = refreshModelPolicyChecked(SPEECH_SETTINGS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    live = { settings: newSettings, durableDeviceId: MACHINE_ID }
    await refreshModelPolicyChecked(newSettings)
    resolveOld(jsonResponse({ ok: true, policy: oldPolicy, signature: sign(SPEECH_TOKEN, oldPolicy) }))
    await oldRefresh
    expect(getVerifiedSpeechPolicySnapshot()?.policy.updatedBy).toBe('new-scope')
  })
})

describe('narrowAllowedForCapability / resolveManagedModel (thin wrappers over the shared pure module)', () => {
  it('with no policy, both are no-ops', () => {
    expect(narrowAllowedForCapability(SETTINGS, ['anthropic'], 'askChat')).toEqual(['anthropic'])
    expect(resolveManagedModel(SETTINGS, 'askChat', 'anthropic', 'my-model')).toBe('my-model')
  })

  it('once a policy is active, narrows providers and pins the model for the governed capability', async () => {
    const doc = policy({
      askChat: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        fallbacks: [{ provider: 'openai', model: 'gpt-5' }]
      }
    })
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    expect(new Set(narrowAllowedForCapability(SETTINGS, null, 'askChat', ['claude-cli', 'local']))).toEqual(
      new Set(['anthropic', 'openai', 'claude-cli', 'local'])
    )
    expect(resolveManagedModel(SETTINGS, 'askChat', 'anthropic', 'whatever')).toBe('claude-sonnet-4-6')
    expect(resolveManagedModel(SETTINGS, 'askChat', 'claude-cli', 'whatever-the-cli-uses')).toBe(
      'whatever-the-cli-uses'
    )
  })
})

describe('resolveLocalSpeechPackPolicy', () => {
  it('defaults unmanaged fleets to offered', () => {
    expect(resolveLocalSpeechPackPolicy(SETTINGS, null)).toBe('offered')
  })

  it('uses the verified signed policy and lets MDM move only toward blocked', async () => {
    const doc = policy({}, 'required')
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    expect(resolveLocalSpeechPackPolicy(SETTINGS, null)).toBe('required')
    expect(resolveLocalSpeechPackPolicy(SETTINGS, 'offered')).toBe('offered')
    expect(resolveLocalSpeechPackPolicy(SETTINGS, 'blocked')).toBe('blocked')
  })

  it('does not let MDM move blocked back toward offered or required', async () => {
    const doc = policy({}, 'blocked')
    setModelPolicyFetchForTests(async () =>
      jsonResponse({ ok: true, policy: doc, signature: sign('shared-secret', doc) })
    )
    await refreshModelPolicy(SETTINGS, NOW)
    expect(resolveLocalSpeechPackPolicy(SETTINGS, 'required')).toBe('blocked')
    expect(resolveLocalSpeechPackPolicy(SETTINGS, 'offered')).toBe('blocked')
  })
})
