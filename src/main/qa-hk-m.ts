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
import { access, mkdir, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { availableMemoryGB } from './llm/available-memory'
import type { AuditEvent } from './logger'
import type { bundledFfmpegPath, startFfmpegDecode } from './ffmpeg-decoder'
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

/**
 * M2-0482: the one gate for every RAM-floor override, shared with M2-0460's HK-M rows. A hosted runner that exposes
 * 7 GiB reads as 7 against the 0.8B model's advertised-RAM floor of 8, and can sit under the prewarm available-memory
 * floor, so the user-facing gates refuse the start before the runtime is reached. The override holds only for a
 * packaged app on an isolated ASKTOTO_USERDATA profile (not the default userData path) whose launch env asks for it
 * exactly: METIS_QA_HOST_FLOOR_OVERRIDE=1, or METIS_HK_M_SCENARIO naming a known row. `userDataPath` is the default
 * userData path the app would use without ASKTOTO_USERDATA.
 */
export function qaHostFloorOverride(env: NodeJS.ProcessEnv, packaged: boolean, userDataPath: string): boolean {
  if (!packaged) return false
  const profile = env.ASKTOTO_USERDATA?.trim()
  // Case-folded: the default macOS and Windows volumes are case-insensitive, so a differently cased spelling of the
  // default profile is still the default profile.
  if (!profile || resolve(profile).toLowerCase() === resolve(userDataPath).toLowerCase()) return false
  return env.METIS_QA_HOST_FLOOR_OVERRIDE === '1' || hkMScenarioFromEnv(env, packaged) !== null
}

export type HostFloor = 'prewarm-available-ram' | 'advertised-ram'
export type HostMemory = { readonly hostTotalBytes: number; readonly hostAvailableBytes: number }
export type HostFloorOverrideAudit = (
  event: Extract<AuditEvent, 'local.host-floor-override'>,
  detail: { floor: HostFloor } & HostMemory
) => void

function currentHostMemory(): HostMemory {
  return { hostTotalBytes: totalmem(), hostAvailableBytes: Math.round(availableMemoryGB() * 1024 ** 3) }
}

// Decided once per process by armQaHostFloorOverride (qa-hooks.ts, as index.ts imports it): the launch env
// and packaging never change while the process runs, and not every floor's module can read Electron's app object.
let hostFloorOverrideArmed = false
const reportedHostFloors = new Set<HostFloor>()

export function armQaHostFloorOverride(env: NodeJS.ProcessEnv, packaged: boolean, userDataPath: string): boolean {
  hostFloorOverrideArmed = qaHostFloorOverride(env, packaged, userDataPath)
  reportedHostFloors.clear()
  return hostFloorOverrideArmed
}

/**
 * Asked only where `floor` has already refused. True when the armed gate lifts it; the first lift of each floor in a
 * process emits one content-free audit event carrying the host's memory figures and nothing else.
 */
export function hostFloorOverridden(
  floor: HostFloor,
  audit: HostFloorOverrideAudit,
  host: () => HostMemory = currentHostMemory
): boolean {
  if (!hostFloorOverrideArmed) return false
  if (!reportedHostFloors.has(floor)) {
    reportedHostFloors.add(floor)
    const { hostTotalBytes, hostAvailableBytes } = host()
    audit('local.host-floor-override', { floor, hostTotalBytes, hostAvailableBytes })
  }
  return true
}

/**
 * M2-0460: the token the HK-M hook's own model start carries down to assertRamOk. Since M2-0482 it is a caller of the
 * one gate and lifts nothing itself: a minted token counts only while the armed qaHostFloorOverride decision holds for
 * a known HK-M row, and then it marks that start with the per-start hk-m.ram-floor-override the HK-M report counts.
 * Tokens are minted only inside productionHkMDeps' model start (the set below is module-private); any other value,
 * caller or process counts as no token.
 */
export interface HkMRamFloorOverride {
  readonly kind: 'hk-m-ram-floor'
}
const mintedRamFloorOverrides = new WeakSet<object>()

export function hkMRamFloorOverrideActive(override: unknown, env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  if (typeof override !== 'object' || override === null || !mintedRamFloorOverrides.has(override)) return false
  return hostFloorOverrideArmed && hkMScenarioFromEnv(env, packaged) !== null
}

/** Content-free detail for hk-m.setup-failed: the row and the error's class name, never its message. */
export function hkMSetupFailedDetail(row: HkMScenario, error: unknown): { row: HkMScenario; error: string } {
  if (!(error instanceof Error)) return { row, error: 'NonError' }
  return { row, error: /^[A-Za-z_$][\w$]{0,63}$/.test(error.name) ? error.name : 'Error' }
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

export const HK_M_MODEL_ID = 'qwen3.5-0.8b'
const HK_M_DECODE_SECONDS = 600
const REGISTRY_WRITE_INTERVAL_MS = 2

/**
 * The runtime pieces the production rows drive. index.ts passes its own static imports: the bytecode-compiled main
 * cannot load modules lazily, and importing them here would drag the Electron-bound modules into this file's unit test.
 */
export interface HkMModules {
  // Spelled out rather than `typeof` llm/local: local-models.ts and local.ts import the floor gate and token from this
  // file, so importing llm/local here would close an import cycle. qa-hooks.ts passes the real function, which tsc checks.
  readonly ensureLocalRuntimeStarted: (
    modelId: string,
    vision?: boolean,
    canStartSpeculatively?: () => boolean,
    ramFloorOverride?: HkMRamFloorOverride
  ) => Promise<void>
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
  const ramFloorOverride: HkMRamFloorOverride = Object.freeze({ kind: 'hk-m-ram-floor' })
  mintedRamFloorOverrides.add(ramFloorOverride)
  return {
    audit,
    onError,
    // Text-only and ungated. On a 7 GiB host the advertised-RAM floor is lifted by the armed qaHostFloorOverride
    // gate (METIS_HK_M_SCENARIO names this row), the same single gate every other QA start goes through; the token
    // only marks this start as the HK-M hook's own.
    startLocalModel: async () => {
      await modules.ensureLocalRuntimeStarted(HK_M_MODEL_ID, false, undefined, ramFloorOverride)
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
      await mkdir(profileDir, { recursive: true })
      const source = join(profileDir, 'hk-m-silence.wav')
      await access(source).catch(() => writeFile(source, silentWav(HK_M_DECODE_SECONDS)))
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
      void (async () => {
        for (;;) {
          modules.recordSidecarIntent('llama-server', ['hk-m-registry-write'])
          await new Promise((resolve) => setTimeout(resolve, REGISTRY_WRITE_INTERVAL_MS))
        }
      })()
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
