/** Test double for the TTS process port: records every spawn and lets a test drive the child's output and exit. */
import type {
  TtsProbeResult,
  TtsProcessHandlers,
  TtsProcessPort,
  TtsProcessSpec
} from '../main/infra/process/tts-process-host'

export interface FakeTtsChild {
  readonly spec: TtsProcessSpec
  killed: number
  line(text: string): void
  exit(code?: number | null): void
  fail(error: string): void
}

export function createFakeTtsPort(): {
  port: TtsProcessPort
  children: FakeTtsChild[]
  probes: Array<{ spec: TtsProcessSpec; timeoutMs: number }>
  probeResult: TtsProbeResult
} {
  const state = {
    children: [] as FakeTtsChild[],
    probes: [] as Array<{ spec: TtsProcessSpec; timeoutMs: number }>,
    probeResult: { ok: true, stdout: '' } as TtsProbeResult
  }
  const port: TtsProcessPort = {
    start(spec, handlers: TtsProcessHandlers) {
      let dead = false
      const child: FakeTtsChild = {
        spec,
        killed: 0,
        line: (text) => {
          if (!dead) handlers.onLine(text)
        },
        exit: (code = 0) => {
          if (dead) return
          dead = true
          handlers.onExit({ code, signal: null })
        },
        fail: (error) => {
          if (dead) return
          dead = true
          handlers.onExit({ code: null, signal: null, error })
        }
      }
      state.children.push(child)
      return {
        kill() {
          if (dead) return
          child.killed += 1
          dead = true
        }
      }
    },
    probe(spec, timeoutMs) {
      state.probes.push({ spec, timeoutMs })
      return Promise.resolve(state.probeResult)
    }
  }
  return Object.assign(state, { port }) as ReturnType<typeof createFakeTtsPort>
}
