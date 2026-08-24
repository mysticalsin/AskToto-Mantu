import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = join(here, '..')
export const LOCAL_MODEL_ID = 'qwen3.5-0.8b'
export const LOCAL_MODEL_DIR = join(REPO_ROOT, 'resources', 'local-llm', 'models', LOCAL_MODEL_ID)
export const LOCAL_MODEL_LICENSE = Object.freeze({
  path: join(REPO_ROOT, 'resources', 'local-llm', 'LICENSE.QWEN3.5-APACHE-2.0.txt'),
  bytes: 11_344,
  sha256: '2410613f992aef11cab1ca584d5732068b6038da37bd140092f09f61dd1c31bd'
})

// Build-time supply-chain manifest. The upstream revision, byte length, and SHA-256 are all immutable
// supply-chain gates. Keep them identical to the entry in src/main/llm/local-models.ts, which is the
// copy that ships and that the first-run downloader verifies against: this manifest's only job is to
// let check-local-model.mjs re-hash the real file and prove those pins before a release goes out.
export const LOCAL_MODEL_ASSETS = Object.freeze([
  Object.freeze({
    file: 'model.gguf',
    sourceFile: 'Qwen3.5-0.8B-UD-Q4_K_XL.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-UD-Q4_K_XL.gguf',
    bytes: 558_772_480,
    sha256: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5'
  }),
  Object.freeze({
    file: 'mmproj.gguf',
    sourceFile: 'mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf',
    bytes: 204_987_232,
    sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453'
  })
])
