/**
 * speaker-id.ts — live "who's speaking" for the THEM loopback channel (SPEAKER-INTELLIGENCE-PLAN §3).
 *
 * Glue between three parts, each independently replaceable:
 *  - a sherpa-onnx SpeakerEmbeddingExtractor (same N-API addon Parakeet already ships — no new native
 *    dependency, identical on macOS and Windows) turning each ≤6s VAD turn into a voice embedding;
 *  - the persistent voiceprint store (userData/voiceprints.json): named profiles built by explicit
 *    enrollment today and by the Teams-VTT auto-enrollment flywheel in P2;
 *  - the pure session clusterer (speaker-cluster.ts) labelling un-enrolled voices "Speaker N".
 *
 * Resolution order per THEM window: enrolled profile match (cosine ≥ ID_THRESHOLD) → session cluster
 * label. Everything degrades to null (no label) when the model is missing, sherpa fails to load, or the
 * embedding is degenerate — a missing label must never break transcription, exactly like the OCR helper.
 *
 * Privacy: embeddings and profiles never leave the machine; the store lives in userData and is removed
 * with the profile delete (P2 Settings surface). PLAN §3.6.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { mainLog } from './logger'
import {
  createSpeakerClusterer,
  cosineSimilarity,
  meanEmbedding,
  type SpeakerClusterer
} from './speaker-cluster'

/** Minimum cosine similarity for an enrolled-profile match. Deliberately above the session-cluster
 *  threshold (0.5): claiming "this is Jane" needs more evidence than "same unnamed voice as before". */
const ID_THRESHOLD = 0.55
/** A silence gap this long between THEM windows means a new meeting — session labels reset. */
const SESSION_GAP_MS = 30 * 60_000
const SAMPLE_RATE = 16_000

export interface SpeakerLabel {
  name: string
  source: 'profile' | 'cluster'
  similarity: number
}

interface VoiceProfile {
  name: string
  centroid: number[]
  samples: number
}

interface EmbeddingExtractor {
  compute: (samples: Float32Array) => Float32Array | null
}

export interface SpeakerIdDeps {
  /** Injected extractor factory (tests). Default builds the sherpa-onnx extractor lazily. */
  createExtractor?: () => EmbeddingExtractor | null
  /** Injected store path (tests). */
  storePath?: () => string
  now?: () => number
  clusterer?: SpeakerClusterer
}

export function speakerModelPath(): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'models')
    : join(findRepoRoot(__dirname), 'resources', 'models')
  return join(base, 'speaker', 'embedding.onnx')
}

function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

/** Build the real sherpa extractor, or null when the model/addon is unavailable. Mirrors parakeet.ts's
 *  memoized-probe posture: one warn per session, never a throw into the audio path. */
function buildSherpaExtractor(): EmbeddingExtractor | null {
  const modelPath = speakerModelPath()
  if (!existsSync(modelPath)) return null
  try {
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
    const sherpa: any = require('sherpa-onnx-node')
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
    const extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: modelPath,
      numThreads: 1,
      provider: 'cpu'
    })
    return {
      compute: (samples: Float32Array) => {
        try {
          const stream = extractor.createStream()
          stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
          // MQA-237: Electron's main process forbids N-API external ArrayBuffers ("External buffers
          // are not allowed"), and sherpa's compute() wraps its output in one by default — so this
          // threw on EVERY window and Speaker Intelligence has been silently dead in the app since it
          // shipped (plain-node unit tests pass; only in-Electron use hits the guard). The binding's own
          // escape hatch: enableExternalBuffer=false copies the embedding instead.
          const embedding = extractor.compute(stream, false) as Float32Array | number[]
          const arr = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding)
          return arr.length > 0 ? arr : null
        } catch (e) {
          mainLog.warn('[speaker-id] embedding failed', e instanceof Error ? e.message : String(e))
          return null
        }
      }
    }
  } catch (e) {
    mainLog.warn('[speaker-id] sherpa extractor unavailable', e instanceof Error ? e.message : String(e))
    return null
  }
}

export interface SpeakerId {
  /** Label one THEM window. Returns null when unavailable/degenerate (caller attaches no name). */
  labelWindow: (samples: Float32Array) => SpeakerLabel | null
  /** Enroll (or reinforce) a named voice profile from one or more turn embeddings' raw audio. */
  enroll: (name: string, sampleWindows: readonly Float32Array[]) => boolean
  listProfiles: () => Array<{ name: string; samples: number }>
  deleteProfile: (name: string) => boolean
  /** True when the extractor is loadable (model present + addon healthy). */
  available: () => boolean
  resetSession: () => void
}

export function createSpeakerId(deps: SpeakerIdDeps = {}): SpeakerId {
  const now = deps.now ?? (() => Date.now())
  const storePath = deps.storePath ?? (() => join(app.getPath('userData'), 'voiceprints.json'))
  const clusterer = deps.clusterer ?? createSpeakerClusterer()
  const createExtractor = deps.createExtractor ?? buildSherpaExtractor

  // Lazy, memoized extractor — the model file may be provisioned after startup, so a null probe is
  // retried when the model appears (cheap existsSync), but a hard addon failure stays failed.
  let extractor: EmbeddingExtractor | null = null
  let probed = false
  const getExtractor = (): EmbeddingExtractor | null => {
    if (extractor) return extractor
    if (probed && deps.createExtractor) return null // injected factories are authoritative
    extractor = createExtractor()
    probed = true
    return extractor
  }

  let profiles: VoiceProfile[] | null = null
  const loadProfiles = (): VoiceProfile[] => {
    if (profiles) return profiles
    try {
      const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as { profiles?: VoiceProfile[] }
      profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.filter((p) => typeof p.name === 'string' && Array.isArray(p.centroid))
        : []
    } catch {
      profiles = []
    }
    return profiles
  }
  const saveProfiles = (): void => {
    try {
      const p = storePath()
      mkdirSync(dirname(p), { recursive: true })
      const tmp = `${p}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, profiles: loadProfiles() }, null, 2), { mode: 0o600 })
      renameSync(tmp, p)
    } catch (e) {
      mainLog.warn('[speaker-id] voiceprint save failed', e instanceof Error ? e.message : String(e))
    }
  }

  let lastWindowAt = 0

  const matchProfile = (embedding: Float32Array): SpeakerLabel | null => {
    let best: SpeakerLabel | null = null
    for (const profile of loadProfiles()) {
      const sim = cosineSimilarity(embedding, Float32Array.from(profile.centroid))
      if (sim >= ID_THRESHOLD && (!best || sim > best.similarity)) {
        best = { name: profile.name, source: 'profile', similarity: sim }
      }
    }
    return best
  }

  return {
    labelWindow: (samples) => {
      const ex = getExtractor()
      if (!ex) return null
      const t = now()
      if (lastWindowAt && t - lastWindowAt > SESSION_GAP_MS) clusterer.reset()
      lastWindowAt = t
      const embedding = ex.compute(samples)
      if (!embedding) return null
      const enrolled = matchProfile(embedding)
      if (enrolled) return enrolled
      const assigned = clusterer.assign(embedding)
      return { name: assigned.label, source: 'cluster', similarity: assigned.similarity }
    },
    enroll: (name, sampleWindows) => {
      const ex = getExtractor()
      if (!ex || !name.trim()) return false
      const embeddings = sampleWindows
        .map((w) => ex.compute(w))
        .filter((e): e is Float32Array => e !== null)
      const centroid = meanEmbedding(embeddings)
      if (!centroid) return false
      const list = loadProfiles()
      const existing = list.find((p) => p.name === name)
      if (existing) {
        // Reinforce: average the stored centroid with the new one, weighted by sample counts.
        const prior = Float32Array.from(existing.centroid)
        const total = existing.samples + embeddings.length
        const merged = new Float32Array(centroid.length)
        for (let i = 0; i < merged.length; i++) {
          merged[i] = (prior[i] * existing.samples + centroid[i] * embeddings.length) / total
        }
        existing.centroid = Array.from(merged)
        existing.samples = total
      } else {
        list.push({ name, centroid: Array.from(centroid), samples: embeddings.length })
      }
      saveProfiles()
      return true
    },
    listProfiles: () => loadProfiles().map((p) => ({ name: p.name, samples: p.samples })),
    deleteProfile: (name) => {
      const list = loadProfiles()
      const idx = list.findIndex((p) => p.name === name)
      if (idx < 0) return false
      list.splice(idx, 1)
      saveProfiles()
      return true
    },
    available: () => getExtractor() !== null,
    resetSession: () => {
      clusterer.reset()
      lastWindowAt = 0
    }
  }
}
