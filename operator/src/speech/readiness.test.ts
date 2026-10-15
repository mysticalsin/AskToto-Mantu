import { describe, expect, it } from 'vitest'
import { resolveSpeechReadiness, validEvidenceReferences } from './readiness'
import type { D1DatabaseLike } from '../d1'

const refs = ['gateway-readback', 'provider-retention', 'synthetic-sink-test', 'relay-runtime-test'].map((kind) => ({
  kind,
  reference: `https://evidence.invalid/${kind}`,
  digest: `sha256:${'a'.repeat(64)}`,
  outcome: 'passed'
}))
const env = {
  SPEECH_TENANT_ID: 'tenant-a',
  SPEECH_AUDIENCE: 'operator',
  SPEECH_DEPLOYMENT_ID: 'staging',
  SPEECH_GATEWAY_ID: 'approved-speech-gateway',
  SPEECH_IMPLEMENTATION_REVISION: 'rev-42',
  SPEECH_POLICY_VERSION: 'policy-3',
  SPEECH_ROUTE_ID: 'deepgram-via-gateway',
  SPEECH_MODEL_ID: 'nova-3',
  SPEECH_CONFIG_VERSION: 'config-7',
  SPEECH_GATEWAY_MANAGEMENT_TOKEN: 'synthetic-management-token',
  SPEECH_GATEWAY_RUN_TOKEN: 'synthetic-run-token',
  SPEECH_DEEPGRAM_API_KEY: 'synthetic-deepgram-key',
  CF_ACCOUNT_ID: 'a'.repeat(32),
  SPEECH_SESSION_DO: {}
}

function d1(row: unknown): D1DatabaseLike {
  return {
    prepare() {
      return {
        bind() {
          return this
        },
        async first<T>() {
          return row as T
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          return { success: true }
        }
      }
    }
  }
}

describe('real speech readiness resolver', () => {
  it('requires four distinct immutable reviewed evidence references and exact matching readback', async () => {
    expect(validEvidenceReferences(JSON.stringify(refs))).toBe(true)
    expect(validEvidenceReferences(JSON.stringify([refs[0], refs[1], refs[1], refs[3]]))).toBe(false)
    const readbacks: string[] = []
    const result = await resolveSpeechReadiness({
      db: d1({
        id: 'evidence-id',
        tenant_id: 'tenant-a',
        audience: 'operator',
        deployment_id: 'staging',
        account_id: 'a'.repeat(32),
        gateway_id: 'approved-speech-gateway',
        route_id: 'deepgram-via-gateway',
        model_id: 'nova-3',
        config_version: 'config-7',
        policy_version: 'policy-3',
        implementation_revision: 'rev-42',
        reviewer_email: 'owner@example.invalid',
        evidence_refs_json: JSON.stringify(refs),
        expires_at: 2_000,
        revoked_at: null
      }),
      env,
      now: 1_000,
      fetchImpl: async (url) => {
        readbacks.push(String(url))
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: 'approved-speech-gateway', collect_logs: false, cache_ttl: 0, logpush: false, otel: [] }
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      }
    })
    expect(result).toMatchObject({ ok: true, evidenceId: 'evidence-id', expiresAt: 2_000 })
    expect(readbacks).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai-gateway/gateways/approved-speech-gateway`
    ])
  })

  it('fails closed for missing database/consumer/evidence or an unsafe named gateway readback', async () => {
    await expect(resolveSpeechReadiness({ env, now: 1_000 })).resolves.toMatchObject({ ok: false })
    await expect(resolveSpeechReadiness({ db: d1(null), env, now: 1_000 })).resolves.toMatchObject({
      ok: false,
      code: 'PRIVACY_UNVERIFIED'
    })
    await expect(
      resolveSpeechReadiness({
        db: d1({ ...{}, evidence_refs_json: JSON.stringify(refs) }),
        env,
        now: 1_000,
        fetchImpl: async () => new Response('unverified')
      })
    ).resolves.toMatchObject({ ok: false, code: 'PRIVACY_UNVERIFIED' })
  })
})
