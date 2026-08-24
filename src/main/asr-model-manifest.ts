/**
 * asr-model-manifest.ts — the high-accuracy transcription model, pinned (MQA-247).
 *
 * `whisper-asr-host.ts` ranks `onnx-community/whisper-large-v3-turbo` FIRST in MODEL_TIERS and falls back
 * to the bundled `Xenova/whisper-base` floor only when the high tier's directory is absent. In a packaged
 * app it is always absent, because it cannot ship: 1.61 GB of weights on top of a 0.77 GB installer is
 * ~2.37 GB, over GitHub's hard 2 GiB per-asset limit (scripts/check-release.mjs fails at 1.9 GiB by
 * design). So every import on every platform decoded with the floor model.
 *
 * The answer is the one MQA-146 already established for the LLM weights under the identical constraint:
 * do not ship them, fetch them once per user profile, size- and SHA-256-pinned against an immutable
 * upstream revision, verified before use.
 *
 * WHY EVERY FILE CARRIES ITS OWN HASH, AND WHY THE REVISION IS A COMMIT
 *
 * scripts/fetch-models.mjs builds its URLs as `/resolve/main/` — a MUTABLE ref. Two builds a month apart
 * can therefore embed different bytes under the same version, and nothing would notice. The LLM manifest
 * pins a 40-hex commit and packaged-model-claims.contract.test.ts enforces that it is never `main`; the
 * ASR side had no such rule. This manifest pins the commit, and asr-model-manifest.test.ts applies the
 * same never-`main` rule to it.
 *
 * The two ONNX blobs are Git-LFS objects, so their `sha256` here is the LFS oid reported by the Hugging
 * Face API for this exact commit — upstream's own digest, not one computed from a local copy that could
 * itself have been wrong. The five small config/tokenizer files are not LFS, so their digests were
 * computed from files whose byte lengths were first confirmed against the same API response. Recorded
 * 2026-08-24 against commit 360ebcde.
 */

/** One pinned file within the model directory. Same shape as LocalModelFile, deliberately. */
export interface AsrModelFile {
  /** Path relative to the model directory, forward slashes as upstream serves them. */
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface AsrModelSpec {
  /** Hugging Face repo id. Doubles as the on-disk directory name, which is what transformers.js resolves. */
  readonly id: string
  /** Immutable commit. Never a branch — see the module note. */
  readonly revision: string
  readonly files: readonly AsrModelFile[]
}

/**
 * The high tier. `id` is also the directory transformers.js looks for under its localModelPath root, so it
 * must stay byte-identical to MODEL_TIERS[0].id in whisper-asr-host.ts — asr-model-manifest.test.ts pins
 * that equality rather than trusting two copies of a string to stay in step.
 */
export const HIGH_TIER_ASR_MODEL: AsrModelSpec = {
  id: 'onnx-community/whisper-large-v3-turbo',
  revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
  files: [
    { path: 'onnx/encoder_model_fp16.onnx', bytes: 1274342603, sha256: 'fdadc70836e6b028fd5e580417c312208dad073d2d01e509e2d127c1373399d8' },
    { path: 'onnx/decoder_model_merged_q4.onnx', bytes: 334147222, sha256: '8b933ac24074a24a1635084d06a4ed37e387ef22d980f184a5fc27418e9ceeb8' },
    { path: 'config.json', bytes: 1332, sha256: '35cd83669f75bc2867f3b3a4461850392d5e308cd6ea951c3700539883c28df1' },
    { path: 'generation_config.json', bytes: 3897, sha256: '16f95291d2f47c944d3c2b19390bba7965666555c1ea2a0bdc850d1fab45612f' },
    { path: 'tokenizer.json', bytes: 2480617, sha256: '6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca' },
    { path: 'tokenizer_config.json', bytes: 282843, sha256: '844b642c73a91359722f47b35705f7174686df33d252695d8572cf9ac03a6389' },
    { path: 'preprocessor_config.json', bytes: 340, sha256: '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711' }
  ]
}

/** Total transfer, for the disk pre-flight and for telling the user what they are agreeing to. */
export function asrModelBytes(spec: AsrModelSpec = HIGH_TIER_ASR_MODEL): number {
  return spec.files.reduce((n, f) => n + f.bytes, 0)
}

/** Where one pinned file is fetched from. Commit-pinned, so the bytes cannot change under a release. */
export function asrModelFileUrl(spec: AsrModelSpec, file: AsrModelFile): string {
  return `https://huggingface.co/${spec.id}/resolve/${spec.revision}/${file.path}`
}
