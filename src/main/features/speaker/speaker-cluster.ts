/**
 * speaker-cluster.ts — pure online clustering for live speaker identification (SPEAKER-INTELLIGENCE-PLAN
 * §3). Zero dependencies, zero I/O: consumes L2-normalizable speaker embeddings (one per ≤6s VAD turn
 * from the THEM loopback channel) and assigns stable session labels ("Speaker 1", "Speaker 2", …) via
 * cosine similarity against rolling centroids. The sherpa-onnx extractor glue lives in speaker-id.ts;
 * keeping the math pure makes every threshold decision unit-testable with synthetic vectors.
 *
 * Algorithm (deliberately simple — diart's incremental-clustering idea collapsed onto our natural
 * turn boundaries): for each embedding, find the most-similar centroid; if similarity ≥ threshold,
 * assign that speaker and update the centroid with an exponential moving average (recent voice matters
 * more than a stale first impression — VoIP codecs drift); otherwise open a new speaker, up to
 * maxSpeakers (beyond that, assign the nearest anyway — a 9th "speaker" in a business meeting is far
 * more likely threshold noise than a real person).
 */

export interface ClusterAssignment {
  /** Stable session label, "Speaker N" (1-based, in order of first appearance). */
  label: string
  /** True when this embedding opened a new cluster. */
  isNew: boolean
  /** Cosine similarity to the assigned centroid BEFORE the EMA update (1 for a brand-new cluster). */
  similarity: number
}

export interface SpeakerClusterer {
  assign: (embedding: Float32Array) => ClusterAssignment
  /** Number of distinct speakers observed so far. */
  size: () => number
  /** Snapshot of a cluster's centroid (for enrollment joins) — null for an unknown label. */
  centroid: (label: string) => Float32Array | null
  /**
   * MQA-238: whole-session agglomerative merge, run once at import end when every window has been seen.
   * The online assign() only looks BACKWARD (a drifting voice opens a new cluster it can never rejoin),
   * so a real 2-speaker meeting came out as 8 labels. This pass repeatedly merges the two most
   * similar clusters while their centroid cosine >= mergeThreshold (count-weighted mean).
   * Speaking briefly is not evidence of being another speaker: low-count clusters must meet the
   * same similarity floor. Survivors are relabeled densely by first appearance.
   * Returns old->final label mapping for every ORIGINAL label (identity entries included).
   */
  mergePass: (opts?: { mergeThreshold?: number }) => Map<string, string>
  reset: () => void
}

export interface ClustererOptions {
  /** Cosine similarity floor to join an existing cluster. Research starting point for 16kHz VoIP
   *  business meetings: 0.45–0.6 (sherpa demo default 0.6 is for clean enrollment audio; loopback
   *  compression argues lower). Calibrated in P0 measurement — keep configurable. */
  threshold?: number
  /** EMA weight of the NEW embedding when updating a centroid. */
  alpha?: number
  /** Soft cap on distinct speakers (see module doc). */
  maxSpeakers?: number
}

const DEFAULT_THRESHOLD = 0.5
const DEFAULT_ALPHA = 0.2
const DEFAULT_MAX_SPEAKERS = 8

/** Cosine similarity. Returns 0 for degenerate (zero-norm) inputs rather than NaN — a silent/broken
 *  window must never poison a centroid with NaN. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Mean of a set of embeddings — used by enrollment (profile centroid from N samples). */
export function meanEmbedding(embeddings: readonly Float32Array[]): Float32Array | null {
  if (embeddings.length === 0) return null
  const dim = embeddings[0].length
  const out = new Float32Array(dim)
  for (const e of embeddings) {
    if (e.length !== dim) return null // mixed models/dims — refuse rather than average garbage
    for (let i = 0; i < dim; i++) out[i] += e[i]
  }
  for (let i = 0; i < dim; i++) out[i] /= embeddings.length
  return out
}

export function createSpeakerClusterer(options: ClustererOptions = {}): SpeakerClusterer {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const alpha = options.alpha ?? DEFAULT_ALPHA
  const maxSpeakers = options.maxSpeakers ?? DEFAULT_MAX_SPEAKERS

  let clusters: Array<{ label: string; centroid: Float32Array; count: number }> = []

  const nearest = (embedding: Float32Array): { index: number; similarity: number } => {
    let best = -1
    let bestSim = -Infinity
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosineSimilarity(embedding, clusters[i].centroid)
      if (sim > bestSim) {
        bestSim = sim
        best = i
      }
    }
    return { index: best, similarity: bestSim }
  }

  const emaUpdate = (index: number, embedding: Float32Array): void => {
    const c = clusters[index]
    for (let i = 0; i < c.centroid.length; i++) {
      c.centroid[i] = (1 - alpha) * c.centroid[i] + alpha * embedding[i]
    }
    c.count++
  }

  return {
    assign: (embedding) => {
      const { index, similarity } = nearest(embedding)
      if (index >= 0 && (similarity >= threshold || clusters.length >= maxSpeakers)) {
        emaUpdate(index, embedding)
        return { label: clusters[index].label, isNew: false, similarity }
      }
      const label = `Speaker ${clusters.length + 1}`
      clusters.push({ label, centroid: Float32Array.from(embedding), count: 1 })
      return { label, isNew: true, similarity: 1 }
    },
    size: () => clusters.length,
    mergePass: (opts) => {
      const mergeThreshold = opts?.mergeThreshold ?? threshold
      // Every original label -> the cluster object currently owning it.
      const owner = new Map<string, { label: string; centroid: Float32Array; count: number }>()
      for (const c of clusters) owner.set(c.label, c)
      const absorb = (
        into: { label: string; centroid: Float32Array; count: number },
        from: { label: string; centroid: Float32Array; count: number }
      ): void => {
        const total = into.count + from.count
        for (let i = 0; i < into.centroid.length; i++) {
          into.centroid[i] = (into.centroid[i] * into.count + from.centroid[i] * from.count) / total
        }
        into.count = total
        for (const [orig, c] of owner) if (c === from) owner.set(orig, into)
        clusters = clusters.filter((c) => c !== from)
      }
      // Agglomerative: closest pair first, while above the floor.
      for (;;) {
        let bi = -1
        let bj = -1
        let best = -Infinity
        for (let i = 0; i < clusters.length; i++) {
          for (let j = i + 1; j < clusters.length; j++) {
            const sim = cosineSimilarity(clusters[i].centroid, clusters[j].centroid)
            if (sim > best) {
              best = sim
              bi = i
              bj = j
            }
          }
        }
        if (bi < 0 || best < mergeThreshold) break
        // Keep the earlier-appearing (lower-numbered) cluster as the survivor.
        absorb(clusters[bi], clusters[bj])
      }
      // Dense relabel by first appearance (original numbering order of the survivors).
      const finalLabel = new Map<{ label: string }, string>()
      let n = 1
      for (const c of clusters) finalLabel.set(c, `Speaker ${n++}`)
      for (const c of clusters) c.label = finalLabel.get(c) as string
      const mapping = new Map<string, string>()
      for (const [orig, c] of owner) mapping.set(orig, finalLabel.get(c) as string)
      return mapping
    },
    centroid: (label) => {
      const c = clusters.find((x) => x.label === label)
      return c ? Float32Array.from(c.centroid) : null
    },
    reset: () => {
      clusters = []
    }
  }
}
