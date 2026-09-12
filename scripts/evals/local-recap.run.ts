import { test, expect, vi } from 'vitest'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { availableParallelism, totalmem, freemem } from 'node:os'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { StreamOptions, StreamCompletion, StreamHandle } from '../../src/main/llm/shared'
import { assertSnapshot, reapOwnedChildren, verifyBinary, withHardDeadline, withGuardedNetwork } from './local-recap-safety.mjs'
import { evaluateRecap, loadSuite, scoreSavedReport, sha256, summarizeRun, type Evaluation, type RecapResult } from './local-recap-evaluator'

const qa = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const configPath = process.env.METIS_LOCAL_RECAP_CONFIG
  if (!configPath) throw new Error('Use node scripts/evals/local-recap.mjs; isolated configuration is required')
  const options = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mode: string; output: string; profile: string; repoRoot: string; gitSha: string;
    binary?: string; binarySha256?: string; temperature?: number; trials: number; baseline?: string; score?: string;
    sourceSnapshot: { inputs: string[]; files: Array<{ path: string; bytes: number; sha256: string }>; sha256: string }
  }
  if (!options.profile || !options.repoRoot) throw new Error('Use node scripts/evals/local-recap.mjs; this runner requires an isolated profile')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: `${options.repoRoot}/resources` })
  const originalFetch = globalThis.fetch
  // Fail closed even during module initialization. The bounded run later permits only owned ports.
  globalThis.fetch = async () => { throw new Error('Network request denied outside isolated local evaluation') }
  return {
    options, originalFetch, children: [] as ChildProcess[], ports: new Set<number>(),
    native: [] as Array<{ requestedPath: string; executable: string; sha256: string; args: string[]; pid?: number; exitCode?: number | null; signal?: string | null }>,
    metrics: [] as unknown[]
  }
})

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => qa.options.profile, getAppPath: () => qa.options.repoRoot, getName: () => 'Metis isolated recap evaluation' } }))
vi.mock('../../src/main/logger', () => ({ mainLog: { info() {}, warn() {}, error() {}, debug() {} }, auditLog: (event: string, payload: unknown) => { if (event === 'llm.call') qa.metrics.push(payload) } }))
// These strategies import account/CLI modules at module load. They are outside this local-only test.
// Keep the real createStream dispatcher, enterprise wrapper, local strategy and OpenAI SDK unchanged.
vi.mock('../../src/main/llm/cli', () => ({ streamCli: () => { throw new Error('CLI provider denied by local eval') } }))
vi.mock('../../src/main/llm/dust', () => ({ streamDust: () => { throw new Error('Dust provider denied by local eval') } }))
vi.mock('../../src/main/llm/anthropic', () => ({ streamAnthropic: () => { throw new Error('Cloud provider denied by local eval') } }))
vi.mock('../../src/main/llm/operator-ask', () => ({ streamOperatorAsk: () => { throw new Error('Operator provider denied by local eval') } }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { verifyBinary: verify } = await import('./local-recap-safety.mjs')
  const denied = () => { throw new Error('Non-runtime child process denied by local eval') }
  return {
    ...actual, exec: denied, execFile: denied, execSync: denied, execFileSync: denied, spawnSync: denied,
    spawn: (requested: string, args: string[], options: SpawnOptions) => {
      if (qa.options.mode !== 'run' || !qa.options.binary || !qa.options.binarySha256 || !/llama-server(?:\.exe)?$/.test(requested)) return denied()
      const verified = verify(qa.options.binary, qa.options.binarySha256)
      const child = actual.spawn(verified.path, args, options)
      qa.children.push(child)
      const record = { requestedPath: requested, executable: verified.path, sha256: verified.sha256, args: args.map((arg, i) => args[i - 1] === '--api-key' ? '<ephemeral-auth-token>' : arg), pid: child.pid } as (typeof qa.native)[number]
      qa.native.push(record)
      let output = ''
      let port: number | undefined
      const discover = (chunk: Buffer) => {
        if (port) return
        output = (output + chunk.toString('utf8')).slice(-16_384)
        const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match) { port = Number(match[1]); qa.ports.add(port) }
      }
      child.stdout?.on('data', discover)
      child.stderr?.on('data', discover)
      child.once('exit', (code, signal) => { record.exitCode = code; record.signal = signal; if (port) qa.ports.delete(port) })
      return child
    }
  }
})
// The allowed strategy uses fetch. Reject direct HTTP clients if a future imported dependency tries
// to bypass it; these shims do not change the built-in implementation of the guarded native fetch.
vi.mock('node:http', async (original) => ({ ...await original<typeof import('node:http')>(), request: () => { throw new Error('Direct HTTP denied by local eval') }, get: () => { throw new Error('Direct HTTP denied by local eval') } }))
vi.mock('node:https', async (original) => ({ ...await original<typeof import('node:https')>(), request: () => { throw new Error('Direct HTTPS denied by local eval') }, get: () => { throw new Error('Direct HTTPS denied by local eval') } }))

import { DEFAULT_SETTINGS } from '../../src/shared/ipc'
import { runImportedRecap, importedTranscriptText, importRecapSystem } from '../../src/main/import-recap'
import { createStream } from '../../src/main/llm'
import { userText } from '../../src/main/llm/shared'
import * as runtime from '../../src/main/llm/local-runtime'
import { getModel, modelPaths, verifyIntegrity } from '../../src/main/llm/local-models'

interface Row extends RecapResult { id: string; caseId: string; trial: number; evaluation: Evaluation; wire: unknown[]; inputSha256: string; systemSha256: string; transcriptSha256: string; ttftMs: number | null; usage?: unknown; cold: boolean }

test('frozen production-chain local recap diagnostic', async () => {
  const { options } = qa
  assertSnapshot(options.repoRoot, options.sourceSnapshot)
  const suite = loadSuite(options.repoRoot)
  if (options.mode === 'check') {
    expect(suite.cases).toHaveLength(16)
    expect(qa.children).toHaveLength(0)
    console.log(`Preflight PASS: ${suite.version}, 16 hash-verified synthetic fixtures. No inference or model download. Production prerequisites: >=50 representative examples and approved latency budget still missing.`)
    return
  }
  if (options.mode === 'score') {
    const saved = JSON.parse(readFileSync(options.score!, 'utf8'))
    const { summary } = scoreSavedReport(suite, saved)
    console.log(JSON.stringify(summary))
    expect(summary.ok, 'Synthetic recap acceptance failed; this is not an enterprise verdict').toBe(true)
    return
  }
  if (options.mode !== 'run') throw new Error('Explicit --run required')
  const verifiedBinary = verifyBinary(options.binary!, options.binarySha256!)
  const modelId = 'qwen3.5-0.8b'
  // Real production integrity checks, no download function or mutable pin substitution.
  await verifyIntegrity(modelId)
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.routingMode = 'local'
  settings.localLlm.enabled = true
  settings.localLlm.modelId = modelId
  settings.localLlm.useFor = { suggest: false, summary: true, vision: false }
  settings.meetingsFolder = join(options.profile, 'meetings')
  if (options.temperature !== undefined) settings.temperature = options.temperature
  const expectedIds = Array.from({ length: options.trials }, (_, trial) => suite.cases.map((fixture) => `${fixture.id}#${trial + 1}`)).flat()
  const rows: Row[] = []
  const prior = options.baseline ? JSON.parse(readFileSync(options.baseline, 'utf8')) : null
  const previous = prior ? scoreSavedReport(suite, prior).rows : undefined
  if (prior && JSON.stringify(prior.expectedIds) !== JSON.stringify(expectedIds)) throw new Error('Baseline must use exactly the same case order and trial count')
  const adjacentLibraries = readdirSync(dirname(verifiedBinary.path)).filter((file) => /\.(?:dll|dylib)$/.test(file)).map((file) => {
    const path = join(dirname(verifiedBinary.path), file)
    return { name: file, bytes: statSync(path).size, sha256: sha256(readFileSync(path)) }
  })
  const started = performance.now()
  const report = {
    schemaVersion: 1, createdAt: new Date().toISOString(), gitSha: options.gitSha, sourceSnapshot: options.sourceSnapshot, trials: options.trials,
    suiteVersion: suite.version, manifestSha256: suite.manifestSha256, expectedIds,
    productionReadiness: suite.productionReadiness,
    limits: { requestHardCeilingMs: 180_000, batchHardCeilingMs: 2_700_000, approvedLatencyBudget: null, externalInferenceCostUsd: 0, localEnergyCost: 'not measured' },
    machine: { platform: process.platform, arch: process.arch, logicalCores: availableParallelism(), totalRam: totalmem(), freeRamAtStart: freemem() },
    binary: { ...verifiedBinary, adjacentLibraries, note: 'Executable checked against caller-reviewed SHA256. Adjacent library hashes recorded, not an upstream signature or complete dynamic-loader inventory.' },
    model: getModel(modelId), resolvedModel: modelPaths(modelId),
    settings: { temperature: settings.temperature, routingMode: settings.routingMode, localLlm: settings.localLlm, summaryLanguage: settings.summaryLanguage, outputLanguage: settings.outputLanguage },
    rows, native: qa.native, metrics: qa.metrics,
    cleanup: { reaped: false, error: undefined as string | undefined }, summary: summarizeRun(expectedIds, rows, previous)
  }
  const save = () => { report.summary = summarizeRun(expectedIds, rows, previous); writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
  let activeRow: Row | undefined
  let activeHandle: StreamHandle | undefined
  const cleanup = async () => {
    activeHandle?.abort()
    runtime.stop()
    try { await reapOwnedChildren(qa.children); report.cleanup.reaped = true }
    catch (error) { report.cleanup.error = error instanceof Error ? error.message : String(error); throw error }
    finally { save() }
  }
  const interrupted = () => { void cleanup().finally(() => process.exit(130)) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  await withGuardedNetwork(qa.originalFetch, qa.ports, (wire: unknown) => activeRow?.wire.push(wire), async () => {
    save()
    for (let trial = 1; trial <= options.trials; trial++) for (const fixture of suite.cases) {
      assertSnapshot(options.repoRoot, options.sourceSnapshot)
      if (performance.now() - started >= 2_700_000) throw new Error('Batch safety ceiling reached; remaining cases are failures, not skipped successes')
      const t0 = performance.now()
      const row: Row = { id: `${fixture.id}#${trial}`, caseId: fixture.id, trial, inputSha256: fixture.inputSha256, systemSha256: sha256(importRecapSystem(true, settings.summaryLanguage, settings.outputLanguage)), transcriptSha256: sha256(importedTranscriptText(fixture.lines)), text: '', wire: [], ttftMs: null, cold: !runtime.isRunning(), evaluation: { ok: false, failures: ['not completed'] } }
      let closed = false
      activeRow = row
      rows.push(row)
      try {
        await withHardDeadline(() => runImportedRecap({ jobId: row.id, mode: 'meeting', lines: fixture.lines }, {
          getSettings: () => settings, getApiKey: () => '', getAllowedProviders: () => ['local'], providerBaseUrl: () => '', redactSecrets: (text) => text,
          createStream: (opts: StreamOptions) => {
            expect(opts.providerId).toBe('local')
            expect(opts.apiKey).toBe('')
            expect(opts.viaOperator).toBe(false)
            expect(opts.req.transcript).toBe(importedTranscriptText(fixture.lines))
            expect(opts.system).toBe(importRecapSystem(true, settings.summaryLanguage, settings.outputLanguage))
            activeHandle = createStream({ ...opts, handlers: {
              onDelta: (delta) => { if (closed) return; if (row.ttftMs === null && delta) row.ttftMs = performance.now() - t0; row.text += delta; opts.handlers.onDelta(delta) },
              onDone: (usage, completion?: StreamCompletion) => { if (closed) return; row.usage = usage; row.completion = completion; opts.handlers.onDone(usage, completion) },
              onError: (error) => { if (closed) return; row.error = error; opts.handlers.onError(error) }
            } })
            return activeHandle
          }
        }), () => { closed = true; activeHandle?.abort(); runtime.stop() }, 180_000)
      } catch (error) { row.error = error instanceof Error ? error.message : String(error) }
      finally {
        closed = true
        activeHandle?.abort()
        activeHandle = undefined
        row.elapsedMs = performance.now() - t0
        try {
        expect(row.wire.length).toBeGreaterThan(0)
        for (const captured of row.wire as Array<{ body: { messages: unknown[]; stream: boolean } }>) {
          expect(captured.body.stream).toBe(true)
          expect(captured.body.messages).toEqual([
            { role: 'system', content: importRecapSystem(true, settings.summaryLanguage, settings.outputLanguage) },
            { role: 'user', content: userText({ id: row.id, mode: 'summary', prompt: '', transcript: importedTranscriptText(fixture.lines), history: [] }) }
          ])
        }
        assertSnapshot(options.repoRoot, options.sourceSnapshot)
        } catch (error) { row.error = [row.error, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; ') }
        row.evaluation = evaluateRecap(fixture, row)
        activeRow = undefined
        save()
      }
      console.log(`${row.id}: ${row.evaluation.ok ? 'PASS' : 'FAIL'}; ${Math.round(row.elapsedMs!)}ms; ${row.completion?.reason ?? 'no completion'}; ${row.evaluation.failures.join('; ')}`)
    }
  }, async () => {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    await cleanup()
  })
  expect(report.summary.ok, `Recap diagnostic failed. Read ${basename(options.output)}; a complete stream is not a semantic pass.`).toBe(true)
})
