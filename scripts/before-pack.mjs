import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')
let runtimeAssetsChecked = false
let leanPackageConfigured = false

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
const LEAN_EXCLUDES = [
  '!node_modules/@huggingface/transformers{,/**/*}',
  '!node_modules/@xenova/transformers{,/**/*}',
  '!node_modules/onnxruntime-common{,/**/*}',
  '!node_modules/onnxruntime-node{,/**/*}',
  '!node_modules/onnxruntime-web{,/**/*}',
  '!node_modules/sherpa-onnx-node{,/**/*}',
  '!node_modules/sherpa-onnx-*{,/**/*}',
  '!node_modules/sharp{,/**/*}',
  '!node_modules/@img{,/**/*}',
  '!out/main/whisper-asr-host.*',
  '!out/main/parakeet-asr-host.*',
  '!out/main/parakeet-extract-host.*',
  '!out/main/speaker-embedding-host.*',
  '!out/renderer/assets/whisper.worker-*',
  '!out/renderer/assets/*onnxruntime*',
  '!out/renderer/assets/ort-wasm-*',
  '!**/*.onnx',
  '!**/*.gguf',
  '!**/*.safetensors',
  '!**/*.tflite'
]

function appendExcludes(config, key) {
  const current = Array.isArray(config[key]) ? config[key] : config[key] == null ? [] : [config[key]]
  config[key] = [...current, ...LEAN_EXCLUDES]
}

function configureLeanBuilder(context, stageRoot) {
  const config = context.packager.config
  config.extraResources = [{ from: stageRoot, to: '.' }]
  config.extraMetadata = { ...(config.extraMetadata ?? {}), metisPackageProfile: 'lean' }
  if (config.mac) config.mac.extraResources = []
  if (config.win) config.win.extraResources = []
  appendExcludes(config, 'files')
  if (config.mac) appendExcludes(config.mac, 'files')
  if (config.win) appendExcludes(config.win, 'files')
}

/** Reject an incomplete offline payload before electron-builder creates a misleading app directory. */
export default async function beforePack(context) {
  const profile = process.env.METIS_PACKAGE_PROFILE ?? 'full'
  if (profile !== 'full' && profile !== 'lean') {
    throw new Error(`METIS_PACKAGE_PROFILE must be exactly "full" or "lean"; got ${JSON.stringify(profile)}`)
  }
  if (profile === 'lean') {
    if (!context || !Number.isInteger(context.arch))
      throw new Error('Lean package selection requires the exact electron-builder architecture')
    const platform = context.electronPlatformName
    const arch = ARCH_NAMES[context.arch]
    if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
      throw new Error(
        `Lean candidates require a separate macOS arm64/x64 or Windows x64 build, got ${platform}/${arch}`
      )
    }
    const expectedArch = process.env.METIS_PACKAGE_ARCH
    if (expectedArch !== arch) {
      throw new Error(`METIS_PACKAGE_ARCH must exactly match this build (${arch}); got ${JSON.stringify(expectedArch)}`)
    }
    if (platform === 'win32' && arch !== 'x64') throw new Error('Lean Windows candidates are x64 only')
    if (!leanPackageConfigured) {
      execFileSync(process.execPath, [join(SCRIPTS_DIR, 'prepare-lean-package-stage.mjs'), platform, arch], {
        cwd: REPO_ROOT,
        stdio: 'inherit'
      })
      configureLeanBuilder(context, join(REPO_ROOT, 'build', 'lean-stage', 'resources'))
      leanPackageConfigured = true
    } else if (process.env.METIS_PACKAGE_ARCH !== arch) {
      throw new Error('One lean build invocation cannot mix package architectures')
    }
    console.log(
      `[before-pack] lean package profile selected for ${platform}/${arch}; strict lean staged-inventory and artifact checks are active.`
    )
    return
  }

  if (context?.packager?.config) {
    let marker
    try {
      marker = JSON.parse(
        await (await import('node:fs/promises')).readFile(join(REPO_ROOT, 'build', 'speech-pack-profile.json'), 'utf8')
      )
    } catch {
      throw new Error('Full packages require the tracked build/speech-pack-profile.json marker')
    }
    if (
      marker?.schema !== 1 ||
      marker.profile !== 'full' ||
      Object.keys(marker).sort().join(',') !== 'profile,schema'
    ) {
      throw new Error('The tracked full package profile marker must remain exactly {"schema":1,"profile":"full"}')
    }
  }
  if (runtimeAssetsChecked) return
  execFileSync(process.execPath, [join(SCRIPTS_DIR, 'check-runtime-assets.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  })
  runtimeAssetsChecked = true
}
