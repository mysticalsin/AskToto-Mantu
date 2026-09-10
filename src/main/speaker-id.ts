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
 * Resolution order per THEM window: echo-bleed check against the operator's own voiceprint (see
 * isEchoBleed below) → enrolled profile match (cosine ≥ ID_THRESHOLD) → session cluster label. Everything
 * degrades to null (no label) when the model is missing, sherpa fails to load, or the embedding is
 * degenerate — a missing label must never break transcription, exactly like the OCR helper.
 *
 * P2 additions (SPEAKER-INTELLIGENCE-PLAN §3.3/§3.4):
 *  - Echo defense: the loopback ('them') channel plays back whatever the mic just captured, so a THEM
 *    window that is actually the operator's own voice bleeding through must not be mislabeled as the
 *    other person. observeOperatorWindow buffers embeddings from 'you' windows (mic side) into a rolling
 *    per-session profile of the operator's own voice, cosine-matched against every THEM window before
 *    anything else runs.
 *  - Auto-enrollment flywheel: labelWindow buffers the last few embeddings behind each live SESSION
 *    cluster label ("Speaker N"). When the Teams-VTT backfill (main/index.ts's backfillSpeakerNames)
 *    later resolves one of those cluster labels to a real name, autoEnrollFromLabeledWindows folds that
 *    buffer into a permanent voiceprint under the real name — zero user effort, the "push further" loop
 *    from the plan's §1. The buffer lives only in memory for the ONE session that produced it (cleared by
 *    resetSession at the next meeting's start boundary — see MQA-043's wiring), so the backfill must run
 *    before the next meeting starts to catch it; a missed window just means no auto-enrollment that time,
 *    never a wrong one.
 *
 * Privacy: embeddings and profiles never leave the machine; the store lives in userData and is removed
 * with the profile delete (P2 Settings surface). PLAN §3.6. The operator's own voiceprint is stored under
 * a reserved name (see OPERATOR_PROFILE_NAME) that listProfiles() never surfaces — it exists purely for
 * echo defense, never as a "person" a user could see or delete from a future enrollment UI by mistake.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { mainLog } from './logger'
import {
  computeSpeakerEmbedding,
  speakerEmbeddingAvailable
} from './speaker-embedding-client'
import type { SpeakerEmbeddingOwner } from './speaker-embedding-protocol'
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
/** Cosine similarity above which a THEM window is treated as the operator's OWN voice leaking through
 *  the loopback rather than the other person speaking. Deliberately higher than ID_THRESHOLD — this is
 *  claiming "you just heard yourself", the strongest claim speaker-id.ts makes, so it needs the strongest
 *  evidence. ~0.7 per SPEAKER-INTELLIGENCE-PLAN §3.3. */
const ECHO_THRESHOLD = 0.7
/** Reserved voiceprint name for the operator's own echo-defense profile (see observeOperatorWindow).
 *  Double-underscore so it can never collide with a real enrolled person's name (enroll() trims/validates
 *  user-typed names, none of which would ever produce this), and listProfiles() filters it out on sight. */
const OPERATOR_PROFILE_NAME = '__operator__'
/** Rolling per-cluster / per-operator embedding buffer size (auto-enrollment + echo defense both use
 *  this). Small on purpose: these buffers exist only to seed/reinforce a voiceprint once a real name is
 *  known (or, for the operator, continuously) — more than a handful of same-voice embeddings adds no
 *  useful signal to a cosine centroid. */
const EMBED_BUFFER_K = 8
/** Quality gate for the auto-enrollment flywheel (SPEAKER-INTELLIGENCE-PLAN §3.4): a session cluster
 *  resolved to a real name by the Teams-VTT backfill only feeds a permanent voiceprint once it actually
 *  accumulated this many windows — a cluster with 1-2 stray windows is exactly the drift/fragment noise
 *  speaker-cluster.ts's own mergePass exists to mop up, not real evidence about a person's voice. */
const AUTO_ENROLL_MIN_WINDOWS = 3

export interface SpeakerLabel {
  name: string
  source: 'profile' | 'cluster'
  similarity: number
  /** True when this window was the operator's OWN voice bleeding through the loopback (see
   *  isEchoBleed) — `name`/`source` are meaningless in this case; the caller should suppress or relabel
   *  the line rather than attribute the operator's own words to "the other person". */
  echo?: boolean
}

/**
 * Exported for unit testing — the pure decision behind labelWindow's echo-defense check (see
 * ECHO_THRESHOLD's block comment above). `operatorCentroid` is null whenever no operator voiceprint
 * exists yet (a brand-new install, or speaker identification just turned on) — echo defense degrades to
 * "never fires" rather than throwing, exactly like every other missing-data case in this file.
 */
export function isEchoBleed(embedding: Float32Array, operatorCentroid: Float32Array | null): boolean {
  if (!operatorCentroid || operatorCentroid.length === 0 || embedding.length !== operatorCentroid.length) {
    return false
  }
  return cosineSimilarity(embedding, operatorCentroid) >= ECHO_THRESHOLD
}

interface VoiceProfile {
  name: string
  centroid: number[]
  samples: number
}

interface EmbeddingExtractor {
  compute: (
    samples: Float32Array,
    owner?: SpeakerEmbeddingOwner
  ) => Float32Array | null | Promise<Float32Array | null>
  available?: (owner?: SpeakerEmbeddingOwner) => boolean | Promise<boolean>
}

export interface SpeakerIdDeps {
  /** Injected extractor factory (tests). Default builds a lazy facade over the isolated native child. */
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

/** Build a lightweight facade over the child-owned native extractor. The parent checks only whether the
 *  model file exists; addon load, constructor, warmup and compute happen exclusively in the utility process. */
function buildSherpaExtractor(): EmbeddingExtractor | null {
  const modelPath = speakerModelPath()
  if (!existsSync(modelPath)) return null
  return {
    compute: (samples, owner = 'live') => computeSpeakerEmbedding(modelPath, samples, owner),
    available: (owner = 'live') => speakerEmbeddingAvailable(modelPath, owner)
  }
}

export interface SpeakerId {
  /** Label one THEM window. Returns null when unavailable/degenerate (caller attaches no name); returns
   *  a label with `echo: true` (see isEchoBleed) when this is the operator's own voice leaking through
   *  the loopback rather than a real THEM utterance — `name`/`source` carry no information in that case. */
  labelWindow: (samples: Float32Array, owner?: SpeakerEmbeddingOwner) => Promise<SpeakerLabel | null>
  /** Enroll (or reinforce) a named voice profile from one or more turn embeddings' raw audio. */
  enroll: (name: string, sampleWindows: readonly Float32Array[]) => Promise<boolean>
  /** Echo defense + operator profile upkeep (SPEAKER-INTELLIGENCE-PLAN §3.3): feed a 'you' (mic) window's
   *  raw audio so the operator's own voiceprint keeps improving across the session. Same degrade-to-noop
   *  contract as everything else here — never throws, never blocks the ASR path that calls it. */
  observeOperatorWindow: (samples: Float32Array, owner?: SpeakerEmbeddingOwner) => Promise<void>
  /** Auto-enrollment flywheel (SPEAKER-INTELLIGENCE-PLAN §3.4): fold each `clusterLabel`'s buffered
   *  session embeddings into a permanent voiceprint under `name`, once that cluster has accumulated at
   *  least AUTO_ENROLL_MIN_WINDOWS windows (quality gate — see its own comment). Called by
   *  main/index.ts's backfillSpeakerNames right after the Teams-VTT alignment resolves a live session
   *  cluster label to a real name. Returns the number of names actually enrolled (0 is a normal outcome,
   *  not a failure — e.g. every candidate cluster was below the quality gate).*/
  autoEnrollFromLabeledWindows: (pairs: readonly { clusterLabel: string; name: string }[]) => number
  listProfiles: () => Array<{ name: string; samples: number }>
  deleteProfile: (name: string) => boolean
  /** True when the extractor is loadable (model present + addon healthy). */
  available: (owner?: SpeakerEmbeddingOwner) => Promise<boolean>
  /** MQA-238: whole-session cluster merge at import end — see SpeakerClusterer.mergePass. Returns the
   *  old->final label mapping so already-emitted lines can be relabeled. Profile-matched names are
   *  untouched (they never came from the clusterer). */
  finalizeSession: () => Map<string, string>
  /** Invalidate pending work and discard transient session buffers without enrolling or persisting them.
   *  Used by the hard privacy off-switch; unlike resetSession, this never flushes the operator buffer. */
  discardSession: () => void
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
  let sessionGeneration = 0

  const compute = async (
    ex: EmbeddingExtractor,
    samples: Float32Array,
    owner: SpeakerEmbeddingOwner
  ): Promise<Float32Array | null> => {
    try {
      return await ex.compute(samples, owner)
    } catch (e) {
      mainLog.warn('[speaker-id] embedding failed', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  const matchProfile = (embedding: Float32Array): SpeakerLabel | null => {
    let best: SpeakerLabel | null = null
    for (const profile of loadProfiles()) {
      if (profile.name === OPERATOR_PROFILE_NAME) continue // never a candidate for a THEM label
      const sim = cosineSimilarity(embedding, Float32Array.from(profile.centroid))
      if (sim >= ID_THRESHOLD && (!best || sim > best.similarity)) {
        best = { name: profile.name, source: 'profile', similarity: sim }
      }
    }
    return best
  }

  // Shared centroid-merge logic behind enroll() (raw audio, the public/manual-enrollment API) and
  // autoEnrollFromLabeledWindows() (already-computed embeddings, the flywheel's internal API) — both
  // ultimately do the same "average this batch into the stored profile, weighted by sample counts" work.
  const enrollEmbeddings = (name: string, embeddings: readonly Float32Array[]): boolean => {
    if (!name.trim() || embeddings.length === 0) return false
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
  }

  // Rolling per-session buffers, capped at EMBED_BUFFER_K each (FIFO — oldest embedding drops first):
  // one per live cluster label ("Speaker N"), feeding the auto-enrollment flywheel; one for the operator's
  // own voice, feeding echo defense. Both are in-memory only and cleared by resetSession() — see the
  // module doc comment above for why that boundary is the right one.
  const clusterEmbeddings = new Map<string, Float32Array[]>()
  const pushCapped = (buf: Float32Array[], embedding: Float32Array): void => {
    buf.push(embedding)
    if (buf.length > EMBED_BUFFER_K) buf.shift()
  }
  let operatorBuffer: Float32Array[] = []
  const operatorCentroid = (): Float32Array | null => {
    // Prefer this SESSION's own operator samples (freshest — codec/mic conditions can drift) blended
    // with the persisted long-term profile when both exist; fall back to whichever one is available.
    const persisted = loadProfiles().find((p) => p.name === OPERATOR_PROFILE_NAME)
    const live = operatorBuffer.length ? meanEmbedding(operatorBuffer) : null
    if (persisted && live) return meanEmbedding([Float32Array.from(persisted.centroid), live])
    if (live) return live
    return persisted ? Float32Array.from(persisted.centroid) : null
  }

  const discardSession = (): void => {
    // Invalidate every native-dependent call before any await continuation can mutate session state.
    sessionGeneration++
    operatorBuffer = []
    clusterEmbeddings.clear()
    clusterer.reset()
    lastWindowAt = 0
  }

  return {
    labelWindow: async (samples, owner = 'live') => {
      const ex = getExtractor()
      if (!ex) return null
      const generation = sessionGeneration
      const t = now()
      const embedding = await compute(ex, samples, owner)
      if (!embedding || generation !== sessionGeneration) return null
      if (lastWindowAt && t - lastWindowAt > SESSION_GAP_MS) {
        clusterer.reset()
      }
      lastWindowAt = t
      // Echo defense FIRST (SPEAKER-INTELLIGENCE-PLAN §3.3): a THEM window that is really the operator's
      // own voice bleeding through the loopback must never reach profile/cluster matching — attributing
      // it to a person (real or "Speaker N") is the exact mislabel this guards against, and letting it
      // through would also pollute a session cluster's centroid with the wrong voice.
      if (isEchoBleed(embedding, operatorCentroid())) {
        return { name: '', source: 'cluster', similarity: 1, echo: true }
      }
      const enrolled = matchProfile(embedding)
      if (enrolled) return enrolled
      const assigned = clusterer.assign(embedding)
      // Buffer this cluster's embedding for the auto-enrollment flywheel (see autoEnrollFromLabeledWindows
      // below) — cheap (a few KB of Float32Array per label, capped) since only the vector is kept, never
      // the raw audio.
      let buf = clusterEmbeddings.get(assigned.label)
      if (!buf) {
        buf = []
        clusterEmbeddings.set(assigned.label, buf)
      }
      pushCapped(buf, embedding)
      return { name: assigned.label, source: 'cluster', similarity: assigned.similarity }
    },
    enroll: async (name, sampleWindows) => {
      const ex = getExtractor()
      if (!ex) return false
      const generation = sessionGeneration
      const embeddings: Float32Array[] = []
      for (const window of sampleWindows) {
        const embedding = await compute(ex, window, 'live')
        if (generation !== sessionGeneration) return false
        if (embedding) embeddings.push(embedding)
      }
      return enrollEmbeddings(name, embeddings)
    },
    observeOperatorWindow: async (samples, owner = 'live') => {
      const ex = getExtractor()
      if (!ex) return
      const generation = sessionGeneration
      const embedding = await compute(ex, samples, owner)
      if (!embedding || generation !== sessionGeneration) return
      pushCapped(operatorBuffer, embedding)
    },
    autoEnrollFromLabeledWindows: (pairs) => {
      let count = 0
      for (const { clusterLabel, name } of pairs) {
        if (!name.trim()) continue
        const embeddings = clusterEmbeddings.get(clusterLabel)
        if (!embeddings || embeddings.length < AUTO_ENROLL_MIN_WINDOWS) continue
        if (enrollEmbeddings(name, embeddings)) count++
      }
      return count
    },
    finalizeSession: () => clusterer.mergePass(),
    listProfiles: () =>
      loadProfiles()
        .filter((p) => p.name !== OPERATOR_PROFILE_NAME)
        .map((p) => ({ name: p.name, samples: p.samples })),
    deleteProfile: (name) => {
      if (name === OPERATOR_PROFILE_NAME) return false // internal profile, never user-deletable
      const list = loadProfiles()
      const idx = list.findIndex((p) => p.name === name)
      if (idx < 0) return false
      list.splice(idx, 1)
      saveProfiles()
      return true
    },
    available: async (owner = 'live') => {
      const ex = getExtractor()
      if (!ex) return false
      try {
        return ex.available ? await ex.available(owner) : true
      } catch (e) {
        mainLog.warn('[speaker-id] extractor unavailable', e instanceof Error ? e.message : String(e))
        return false
      }
    },
    discardSession,
    resetSession: () => {
      // Flush this session's operator samples into the persisted profile BEFORE clearing — the
      // resetSession boundary is the next meeting's START (see MQA-043's wiring in index.ts), so this
      // flushes the meeting that just ended. Same AUTO_ENROLL_MIN_WINDOWS quality gate as the flywheel:
      // a session with only 1-2 'you' windows (a near-silent mic-only stretch) adds no useful signal.
      if (operatorBuffer.length >= AUTO_ENROLL_MIN_WINDOWS) enrollEmbeddings(OPERATOR_PROFILE_NAME, operatorBuffer)
      discardSession()
    }
  }
}
