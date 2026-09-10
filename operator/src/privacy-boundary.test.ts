import { describe, expect, it } from 'vitest'
import { buildDashboard, buildLiveSnapshot } from './dashboard'
import { handleRequest, type Env } from './index'
import { memoryStore, type AskRow } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const PRIVATE_ASK = 'Customer Alpha acquisition plan'
const PRIVATE_CRM = 'Patient diagnosis and private meeting notes'
const PRIVATE_EVENT = '/Users/tony/Customer Alpha/private-meeting.md'
const PRIVATE_EVIDENCE = 'Ask said to acquire Customer Alpha tomorrow'

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: '',
    ...overrides
  }
}

function legacyAsk(overrides: Partial<AskRow> = {}): AskRow {
  return {
    id: 'legacy-ask', device_id: 'device-a', ts: NOW, mode: 'answer', skill_id: 'interview',
    skill_version: '1.0.0', provider: 'anthropic', model: 'claude', ttft_ms: 20, total_ms: 120,
    input_tokens: 40, output_tokens: 12, cache_read: 30, cache_write: 0, cache_uncached: 10,
    cache_status: 'hit', cache_ttl: '1h', outcome: 'answered', rating: 'down',
    prompt_cipher: 'legacy-secret-ciphertext', prompt_iv: 'legacy-secret-iv', preview: PRIVATE_ASK,
    question_type: 'how-to', path_tag: 'seat-local', ...overrides
  }
}

describe('legacy server privacy projections', () => {
  it('returns only approved Ask metadata and permanently refuses content reveal', async () => {
    const store = memoryStore()
    await store.insertAsk(legacyAsk())

    const list = await handleRequest(
      new Request('https://operator.test/v1/admin/asks'), env(), { access: tonyAccess }, { store, now: NOW }
    )
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { asks: Record<string, unknown>[] }
    expect(listBody.asks[0]).toMatchObject({
      id: 'legacy-ask', provider: 'anthropic', input_tokens: 40, cache_read: 30,
      rating: 'down', question_type: 'how-to', preview: 'answer ask · How to'
    })
    const listText = JSON.stringify(listBody)
    for (const forbidden of [PRIVATE_ASK, 'legacy-secret-ciphertext', 'legacy-secret-iv']) {
      expect(listText).not.toContain(forbidden)
    }

    const reveal = await handleRequest(
      new Request('https://operator.test/v1/admin/asks/legacy-ask'),
      env({ OPERATOR_PROMPT_KEY: '' }),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(reveal.status).toBe(410)
    expect(await reveal.json()).toEqual({ ok: false, error: 'Ask content is unavailable' })
  })

  it('does not carry Ask previews into new or legacy skill evidence', async () => {
    const store = memoryStore()
    await store.insertAsk(legacyAsk())
    await store.putProposal({
      id: 'legacy-proposal', skill_id: 'interview', from_version: '1.0.0',
      evidence_json: JSON.stringify([PRIVATE_EVIDENCE]), diff: '# safe admin-authored diff',
      rationale: PRIVATE_EVIDENCE, status: 'pending', created_by: 'tony.walteur@gmail.com',
      created_at: NOW - 1, decided_at: null, reject_reason: null
    })

    const draft = await handleRequest(
      new Request('https://operator.test/v1/admin/skills/draft', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillId: 'interview' })
      }),
      env(), { access: tonyAccess }, { store, now: NOW }
    )
    expect(draft.status).toBe(200)
    const proposals = await store.listProposals(10)
    const created = proposals.find((row) => row.id !== 'legacy-proposal')
    expect(created?.evidence_json).toBe('[]')
    expect(`${created?.evidence_json} ${created?.rationale}`).not.toContain(PRIVATE_ASK)

    const dashboard = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    const dashboardText = JSON.stringify(dashboard)
    expect(dashboardText).not.toContain(PRIVATE_EVIDENCE)
    expect(dashboardText).not.toContain(PRIVATE_ASK)
  })

  it('projects legacy CRM and event content before dashboard and live responses', async () => {
    const store = memoryStore()
    await store.insertAsk(legacyAsk())
    await store.upsertCrm({
      id: 'legacy-crm', device_id: 'device-a', ts: NOW, status: 'failed', title: PRIVATE_CRM,
      connector: 'hubspot', meeting_file: PRIVATE_EVENT, meeting_hash: 'aabbccddeeff0011',
      last_error: `timeout ${PRIVATE_CRM}`, retry_requested: 1, attempt: 3, latency_ms: 456,
      remote_id: 'patient-42', remote_url: 'https://crm.example/patient-42', action: 'send-diagnosis'
    })
    await store.insertEvent({
      id: 'legacy-event', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'device-a', country: 'CA', detail: PRIVATE_EVENT
    })

    const dashboard = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    const live = await buildLiveSnapshot(store, NOW)
    const output = JSON.stringify({ dashboard, live })
    for (const forbidden of [PRIVATE_ASK, PRIVATE_CRM, PRIVATE_EVENT, 'patient-42', 'send-diagnosis']) {
      expect(output).not.toContain(forbidden)
    }
    expect(dashboard.crm.rows[0]).toMatchObject({
      id: 'legacy-crm', status: 'failed', title: 'CRM delivery', connector: 'hubspot',
      error: 'transient', retryRequested: true, attempt: 3, latencyMs: 456,
      remoteId: null, remoteUrl: null, meetingHash: null, action: null
    })
    expect(dashboard.asks[0]).toMatchObject({ id: 'legacy-ask', preview: 'answer ask · How to' })
  })

  it('clears legacy CRM content when an administrator requests a retry', async () => {
    const store = memoryStore()
    await store.upsertCrm({
      id: 'retry-crm', device_id: 'device-a', ts: NOW - 1, status: 'failed', title: PRIVATE_CRM,
      connector: 'hubspot', meeting_file: PRIVATE_EVENT, meeting_hash: 'aabbccddeeff0011',
      last_error: `timeout ${PRIVATE_CRM}`, retry_requested: 0, attempt: 2, latency_ms: 99,
      remote_id: 'patient-42', remote_url: 'https://crm.example/patient-42', action: 'send-diagnosis'
    })
    const response = await handleRequest(
      new Request('https://operator.test/v1/admin/crm/retry-crm/retry', { method: 'POST', body: '{}' }),
      env(), { access: tonyAccess }, { store, now: NOW }
    )
    expect(response.status).toBe(200)
    const row = await store.getCrm('retry-crm')
    expect(row).toMatchObject({
      status: 'pending', retry_requested: 1, title: 'CRM delivery', last_error: 'transient',
      meeting_file: null, meeting_hash: null, remote_id: null, remote_url: null, action: null
    })
    expect(JSON.stringify(row)).not.toContain(PRIVATE_CRM)
    expect(JSON.stringify(row)).not.toContain('patient-42')
  })
})
