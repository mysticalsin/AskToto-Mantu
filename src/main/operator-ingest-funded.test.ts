import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '1.8.2', getPath: () => '/tmp' } }))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test' }))
vi.mock('./logger', () => ({
  mainLog: { warn: vi.fn() },
  // auth.ts registers an audit actor at module load — a real seatMeta() now imports it for ssoEmail.
  setAuditActor: () => {},
  auditLog: () => {}
}))

import {
  fundedProvidersFromHeartbeat,
  operatorAskTransport,
  operatorFundedProviders,
  operatorHeartbeat,
  setOperatorFetchForTests,
  setOperatorFundedProvidersForTests,
  setOperatorQueueDirForTests
} from './operator-ingest'

describe('heartbeat fundedProviders — IDs only, never secrets', () => {
  // Isolated per-test queue dir: operatorHeartbeat now drains/reports the durable outbox on every
  // call, and a shared literal '/tmp' would leak queue state across test files and runs.
  let queueDir: string
  beforeEach(() => {
    setOperatorFundedProvidersForTests([])
    setOperatorFetchForTests(null)
    queueDir = mkdtempSync(join(tmpdir(), 'operator-ingest-funded-test-'))
    setOperatorQueueDirForTests(queueDir)
  })
  afterEach(() => {
    setOperatorQueueDirForTests(null)
    rmSync(queueDir, { recursive: true, force: true })
  })

  it('keeps Operator-hosted IDs and drops CLI, Dust, local, and vault-looking rows', () => {
    expect(
      fundedProvidersFromHeartbeat({
        ok: true,
        fundedProviders: ['anthropic', 'claude-cli', 'dust', 'local', 'cloudflare-account', 'openai', 'sk-ant-secret']
      })
    ).toEqual(['anthropic', 'openai'])
  })

  it('stores heartbeat IDs in RAM only and never treats a secret as a provider id', async () => {
    setOperatorFetchForTests(async () =>
      new Response(JSON.stringify({ ok: true, retry: [], fundedProviders: ['anthropic', 'dust'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const beat = await operatorHeartbeat({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(beat.ok).toBe(true)
    expect(operatorFundedProviders()).toEqual(['anthropic'])
    expect(JSON.stringify(operatorFundedProviders())).not.toContain('ingest-secret')
  })

  it('does not treat Access login HTML as a successful heartbeat', async () => {
    setOperatorFetchForTests(
      async () =>
        new Response(
          '<!DOCTYPE html><html><body>Sign in · Cloudflare Access https://team.cloudflareaccess.com</body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        )
    )
    const beat = await operatorHeartbeat({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(beat.ok).toBe(false)
    expect(operatorFundedProviders()).toEqual([])
  })

  it('Ask transport is URL + ingest secret only — never an LLM key', () => {
    const t = operatorAskTransport({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(t).toEqual({ url: 'https://operator.test', secret: 'ingest-secret' })
    expect(JSON.stringify(t)).not.toMatch(/sk-ant|sk-|ANTHROPIC/)
  })
})
