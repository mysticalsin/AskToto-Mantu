/**
 * manifest.ts — the on-device speech packs, pinned per file (M2-0475).
 *
 * The per-file bytes and sha256 below are the ones in resources/runtime-assets-manifest.json; manifest.test.ts
 * fails on any difference, so the downloadable pack and the packaged floor can never drift apart silently.
 *
 * SOURCES ARE IMMUTABLE. A source URL is pinned to a commit (per-file hosts) or to an archive whose own byte
 * count and sha256 are pinned, never to a branch. An upstream pin that has not been recorded yet is `null`:
 * the engine then refuses to fetch (error kind 'http') instead of guessing a URL. Recording the value is the
 * only change needed to enable that pack. A different first source (for example an R2 route) can replace the
 * URL without touching a single file pin, because every extracted or downloaded file is checked against its
 * own pin regardless of where it came from.
 */

export type SpeechPackComponentId = 'asr.whisper-base-q8' | 'asr.parakeet-tdt-0.6b-v3-int8'

export interface SpeechPackFile {
  /** Path relative to the pack directory, forward slashes. */
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface SpeechPackArchivePin {
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

export type SpeechPackSource =
  | {
      readonly kind: 'files'
      /** Immutable prefix (commit-pinned); each file is fetched from `${baseUrl}/${file.path}`. Null = not recorded yet. */
      readonly baseUrl: string | null
    }
  | {
      readonly kind: 'archive'
      /** The upstream archive pinned by its own length and digest. Null = not recorded yet. */
      readonly archive: SpeechPackArchivePin | null
      /** Directory inside the archive that holds the pinned files. */
      readonly entryPrefix: string
      /** Upper bound on the total size of everything extracted. */
      readonly extractCapBytes: number
    }

export interface SpeechPackComponent {
  readonly id: SpeechPackComponentId
  /** Directory name under userData/speech-packs/<id>/. */
  readonly version: string
  readonly files: readonly SpeechPackFile[]
  readonly source: SpeechPackSource
}

/** The fixture the self-test decodes before a pack may be activated. */
export const SELF_TEST_FIXTURE = {
  name: 'en.wav',
  bytes: 184_608,
  sha256: '148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6'
} as const

/** Commit of Xenova/whisper-base the pack is fetched from. Not recorded yet, so the pack cannot be fetched. */
export const WHISPER_BASE_REVISION: string | null = null

/** sherpa-onnx release archive for the Parakeet pack. Not recorded yet, so the pack cannot be fetched. */
export const PARAKEET_ARCHIVE_PIN: SpeechPackArchivePin | null = null

const PARAKEET_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'

export const WHISPER_BASE_Q8: SpeechPackComponent = {
  id: 'asr.whisper-base-q8',
  version: '1',
  source: {
    kind: 'files',
    baseUrl: WHISPER_BASE_REVISION ? `https://huggingface.co/Xenova/whisper-base/resolve/${WHISPER_BASE_REVISION}` : null
  },
  files: [
    { path: 'config.json', bytes: 2248, sha256: 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b' },
    { path: 'generation_config.json', bytes: 3776, sha256: '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05' },
    { path: 'merges.txt', bytes: 493869, sha256: '2df2990a395e35e8dfbc7511e08c12d56018d8d04691e0133e5d63b21e154dc6' },
    { path: 'normalizer.json', bytes: 52666, sha256: 'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd' },
    { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 53707539, sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861' },
    { path: 'onnx/encoder_model_quantized.onnx', bytes: 23200850, sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9' },
    { path: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
    { path: 'special_tokens_map.json', bytes: 2194, sha256: 'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691' },
    { path: 'tokenizer.json', bytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
    { path: 'tokenizer_config.json', bytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
    { path: 'vocab.json', bytes: 1036584, sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a' }
  ]
}

export const PARAKEET_TDT_V3_INT8: SpeechPackComponent = {
  id: 'asr.parakeet-tdt-0.6b-v3-int8',
  version: '1',
  source: { kind: 'archive', archive: PARAKEET_ARCHIVE_PIN, entryPrefix: PARAKEET_DIR, extractCapBytes: 800_000_000 },
  files: [
    { path: 'decoder.int8.onnx', bytes: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    { path: 'encoder.int8.onnx', bytes: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
    { path: 'joiner.int8.onnx', bytes: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    { path: 'tokens.txt', bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' }
  ]
}

export const SPEECH_PACK_COMPONENTS: readonly SpeechPackComponent[] = [WHISPER_BASE_Q8, PARAKEET_TDT_V3_INT8]

export function componentBytes(component: SpeechPackComponent): number {
  return component.files.reduce((n, f) => n + f.bytes, 0)
}

/** A URL that names a branch can serve different bytes tomorrow; refuse it before the network is touched. */
export function isImmutableUrl(url: string): boolean {
  return !/\/(resolve|blob|raw|tree)\/(main|master|HEAD)\//i.test(url) && !/refs\/heads\//i.test(url)
}

/** Where one pinned file is fetched from, or null when the source pin has not been recorded. */
export function speechPackFileUrl(component: SpeechPackComponent, file: SpeechPackFile): string | null {
  const source = component.source
  if (source.kind !== 'files' || source.baseUrl === null) return null
  return `${source.baseUrl}/${file.path}`
}
