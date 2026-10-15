import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import { baseURL, isRunning, resolveBinaryPath, sessionKey, start, stop } from './local-runtime'
import { LOCAL_MODELS, spawnProfileFor } from './local-models'
import { macSupervisorHelperPath } from '../infra/process/supervisor'
import { auditLog } from '../logger'

const resolverCaseName = 'performs real health, auth, inference and owned-child shutdown through production resolver'
const cpuCaseName = 'performs real health, auth, inference and owned-child shutdown with explicit CPU binary'
const suiteName = 'required native local-runtime qualification'
const caseWitnesses: Array<Record<string, string>> = []

async function qualifyRuntime(
  caseId: string,
  testFullName: string,
  binary: string | undefined,
  expectedVariant?: 'cpu' | 'vulkan' | 'mac'
) {
  const expectedPlatform = process.env.EXPECTED_PLATFORM
  const expectedArch = process.env.EXPECTED_ARCH
  const nativePlatform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : null
  expect(nativePlatform, 'unsupported native host').not.toBeNull()
  expect(process.platform).toBe(expectedPlatform)
  expect(process.arch).toBe(expectedArch)

  const modelRoot = join(process.cwd(), 'resources', 'local-llm', 'models', 'qwen3.5-0.8b')
  const gguf = join(modelRoot, 'model.gguf')
  const mmproj = join(modelRoot, 'mmproj.gguf')
  const entry = LOCAL_MODELS.find((model) => model.id === 'qwen3.5-0.8b')
  expect(entry, 'qwen3.5-0.8b must remain the pinned native qualification model').toBeDefined()
  expect(existsSync(gguf), `verified model missing: ${gguf}`).toBe(true)
  expect(existsSync(mmproj), `verified projector missing: ${mmproj}`).toBe(true)

  let base: URL | undefined
  vi.mocked(auditLog).mockClear()
  try {
    if (nativePlatform === 'mac') {
      const helper = macSupervisorHelperPath()
      expect(existsSync(helper), 'this qualification does not build or qualify the mac supervision helper').toBe(false)
    }
    await start(
      { gguf, mmproj, vision: false, ...spawnProfileFor(entry!, 16, 8), ...(binary ? { runtimeBinary: binary } : {}) },
      nativePlatform!
    )
    expect(isRunning()).toBe(true)
    expect(sessionKey()).toMatch(/^[0-9a-f]{64}$/)
    base = new URL(baseURL())
    const health = await fetch(`${base.protocol}//${base.host}/health`)
    expect(health.status).toBe(200)
    const body = JSON.stringify({
      model: 'local',
      messages: [{ role: 'user', content: 'Reply with one short word.' }],
      max_tokens: 8
    })
    const headers = { 'content-type': 'application/json' }
    const unauthed = await fetch(`${base.protocol}//${base.host}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body
    })
    expect(unauthed.status).toBe(401)
    const authed = await fetch(`${base.protocol}//${base.host}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${sessionKey()}` },
      body
    })
    expect(authed.status).toBe(200)
    const completion = (await authed.json()) as { choices?: Array<{ message?: { content?: string } }> }
    expect(completion.choices?.[0]?.message?.content?.trim().length ?? 0).toBeGreaterThan(0)

    const startEvent = vi.mocked(auditLog).mock.calls.find(([event]) => event === 'local.runtime.start')
    const observedVariant = (startEvent?.[1] as { variant?: string } | undefined)?.variant
    expect(observedVariant, 'production start audit event must identify the executed runtime variant').toBeDefined()
    if (expectedVariant) expect(observedVariant).toBe(expectedVariant)
    if (!binary && nativePlatform === 'win') {
      const candidates = resolveBinaryPath('win')
      expect(candidates.map((candidate) => candidate.variant)).toEqual(['vulkan', 'cpu'])
      expect(['cpu', 'vulkan']).toContain(observedVariant)
    }
    const witness = {
      caseId,
      testFullName,
      platform: process.platform,
      arch: process.arch,
      variant: observedVariant!,
      selection: binary ? 'explicit-cpu' : 'production-resolver',
      gpuQualification: 'NOT_QUALIFIED',
      macSupervision: nativePlatform === 'mac' ? 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED' : 'NOT_APPLICABLE',
      inference: 'NONEMPTY'
    }
    caseWitnesses.push(witness)
    console.log(`NATIVE_RUNTIME_CASE ${JSON.stringify(witness)}`)
  } finally {
    await stop()
  }
  expect(isRunning()).toBe(false)
  expect(base).toBeDefined()
  await expect(
    fetch(`${base!.protocol}//${base!.host}/health`, { signal: AbortSignal.timeout(2_000) })
  ).rejects.toThrow()
}

afterEach(async () => {
  await stop()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  const witnessPath = process.env.NATIVE_CASE_REPORT
  if (!witnessPath) throw new Error('NATIVE_CASE_REPORT must name the owned native-case witness file')
  await writeFile(witnessPath, `${JSON.stringify(caseWitnesses, null, 2)}\n`, { flag: 'wx' })
})

describe('required native local-runtime qualification', () => {
  it(
    resolverCaseName,
    async () =>
      qualifyRuntime(
        'native-resolver',
        `${suiteName} ${resolverCaseName}`,
        undefined,
        process.platform === 'darwin' ? 'mac' : undefined
      ),
    60_000
  )
  if (process.platform === 'win32') {
    it(
      cpuCaseName,
      async () =>
        qualifyRuntime(
          'native-explicit-cpu',
          `${suiteName} ${cpuCaseName}`,
          join(process.cwd(), 'resources', 'llama', 'win', 'cpu', 'llama-server.exe'),
          'cpu'
        ),
      60_000
    )
  }
})
