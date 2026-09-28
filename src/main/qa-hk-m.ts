/**
 * qa-hk-m.ts — the app side of scripts/qa/hk-m.mjs, the packaged sidecar-supervision proof.
 *
 * The harness launches the installed app against a throwaway ASKTOTO_USERDATA profile with
 * METIS_HK_M_SCENARIO=<row>, waits for the row's content-free marker, then SIGKILLs main. This module holds
 * each row's owned work open (a starting model, a live completion, a blocked ffmpeg decode, a registry write
 * loop) and stamps the marker once the work is genuinely in flight. It reads no user data: the model prompt is
 * a fixed string, the decode source is generated silence inside the throwaway profile.
 *
 * Inert unless the app is packaged AND running on an isolated QA profile AND the env names a known row.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEvent } from './logger'
import type { bundledFfmpegPath, startFfmpegDecode } from './ffmpeg-decoder'
import type { ensureLocalRuntimeStarted } from './llm/local'
import type * as localRuntime from './llm/local-runtime'
import type { recordSidecarIntent } from './infra/process/registry'

export const HK_M_SCENARIOS = ['idle', 'model-starting', 'active-inference', 'ffmpeg-import', 'registry-write'] as const
export type HkMScenario = (typeof HK_M_SCENARIOS)[number]

export type HkMMarker = Extract<AuditEvent, 'hk-m.active-inference' | 'hk-m.ffmpeg-import' | 'hk-m.registry-write'>

export function hkMScenarioFromEnv(env: NodeJS.ProcessEnv, packaged: boolean): HkMScenario | null {
  if (!packaged || !env.ASKTOTO_USERDATA?.trim()) return null
  const value = env.METIS_HK_M_SCENARIO
  return HK_M_SCENARIOS.find((scenario) => scenario === value) ?? null
}

export interface HkMDeps {
  readonly audit: (event: HkMMarker) => void
  /** Start the bundled local model through the normal runtime path; resolves once it is healthy. */
  readonly startLocalModel: () => Promise<void>
  /** Dispatch a long streaming completion to the running local model without waiting for it. */
  readonly beginInference: () => void
  /** Start a real ffmpeg decode that stays blocked mid-decode; resolves once the decoder is producing. */
  readonly holdFfmpegDecode: () => Promise<void>
  /** Append sidecar-registry records continuously until the process dies. */
  readonly writeRegistryUntilKilled: () => void
  readonly onError: (scenario: HkMScenario, error: unknown) => void
}

export async function runHkMScenario(scenario: HkMScenario, deps: HkMDeps): Promise<void> {
  try {
    switch (scenario) {
      case 'idle':
        return
      case 'model-starting':
        // Deliberately not awaited: the row kills main while the sidecar is still loading the model.
        void deps.startLocalModel().catch((error) => deps.onError(scenario, error))
        return
      case 'active-inference':
        await deps.startLocalModel()
        deps.beginInference()
        deps.audit('hk-m.active-inference')
        return
      case 'ffmpeg-import':
        await deps.holdFfmpegDecode()
        deps.audit('hk-m.ffmpeg-import')
        return
      case 'registry-write':
        deps.audit('hk-m.registry-write')
        deps.writeRegistryUntilKilled()
        return
    }
  } catch (error) {
    deps.onError(scenario, error)
  }
}

const HK_M_MODEL_ID = 'qwen3.5-0.8b'
const HK_M_DECODE_SECONDS = 600
const REGISTRY_WRITE_INTERVAL_MS = 2

/**
 * The runtime pieces the production rows drive. index.ts passes its own static imports: the bytecode-compiled main
 * cannot load modules lazily, and importing them here would drag the Electron-bound modules into this file's unit test.
 */
export interface HkMModules {
  readonly ensureLocalRuntimeStarted: typeof ensureLocalRuntimeStarted
  readonly localRuntime: Pick<typeof localRuntime, 'markActivity' | 'baseURL' | 'sessionKey'>
  readonly bundledFfmpegPath: typeof bundledFfmpegPath
  readonly startFfmpegDecode: typeof startFfmpegDecode
  readonly recordSidecarIntent: typeof recordSidecarIntent
}

export function productionHkMDeps(
  modules: HkMModules,
  audit: HkMDeps['audit'],
  onError: HkMDeps['onError'],
  profileDir: string,
  resourcesDir: string
): HkMDeps {
  return {
    audit,
    onError,
    startLocalModel: async () => {
      await modules.ensureLocalRuntimeStarted(HK_M_MODEL_ID)
    },
    beginInference: () => {
      void (async () => {
        const runtime = modules.localRuntime
        runtime.markActivity()
        const response = await fetch(`${runtime.baseURL()}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.sessionKey()}` },
          body: JSON.stringify({
            model: 'local',
            messages: [{ role: 'user', content: 'Count upward from 1, one number per line, without stopping.' }],
            max_tokens: 4096,
            stream: true
          })
        })
        // Read slowly enough that the sidecar is still generating when main dies.
        for await (const _chunk of response.body ?? []) await new Promise((resolve) => setTimeout(resolve, 50))
      })().catch((error) => onError('active-inference', error))
    },
    holdFfmpegDecode: async () => {
      const executable = modules.bundledFfmpegPath(resourcesDir)
      if (!executable) throw new Error('bundled ffmpeg missing')
      mkdirSync(profileDir, { recursive: true })
      const source = join(profileDir, 'hk-m-silence.wav')
      if (!existsSync(source)) writeFileSync(source, silentWav(HK_M_DECODE_SECONDS))
      await new Promise<void>((resolve, reject) => {
        let running = false
        const started = modules.startFfmpegDecode(executable, source, 0, {
          // The first decoded window proves ffmpeg is producing; never resolving the chunk stops the reader,
          // so ffmpeg blocks on its full output pipe and stays alive until main dies.
          onChunk: () => {
            if (!running) {
              running = true
              resolve()
            }
            return new Promise<void>(() => {})
          },
          onComplete: async () => {
            if (!running) reject(new Error('ffmpeg decode finished before it could be held open'))
          },
          onError: async (error) => reject(error)
        })
        void started.completed
      })
    },
    writeRegistryUntilKilled: () => {
      setInterval(() => modules.recordSidecarIntent('llama-server', ['hk-m-registry-write']), REGISTRY_WRITE_INTERVAL_MS)
    }
  }
}

/** 16 kHz mono 16-bit PCM silence with a valid RIFF header. */
function silentWav(seconds: number): Buffer {
  const dataBytes = seconds * 16_000 * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}
