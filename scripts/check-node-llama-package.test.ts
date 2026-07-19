import { describe, expect, it } from 'vitest'
import {
  validatePackagedAsarEntries,
  validatePackagedManifest,
  validateSherpaPackages,
  validateWorkerSources
} from './check-node-llama-package.mjs'

const SHA256 = 'a'.repeat(64)
const VISION_COMPONENTS = [
  'config',
  'generation-config',
  'decoder-model',
  'embed-tokens',
  'vision-encoder',
  'preprocessor-config',
  'processor-config',
  'tokenizer',
  'tokenizer-config'
]
const FLORENCE_COMPONENTS = [
  'config',
  'generation-config',
  'decoder-model',
  'embed-tokens',
  'encoder-model',
  'vision-encoder',
  'preprocessor-config',
  'tokenizer',
  'tokenizer-config'
]

function fileRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'record',
    destination: 'record.bin',
    bytes: 1,
    sha256: SHA256,
    ...overrides
  }
}

function manifest(platform: 'darwin-arm64' | 'win32-x64' = 'darwin-arm64') {
  return {
    schemaVersion: 1,
    targetPlatform: platform,
    catalogSha256: 'b'.repeat(64),
    approval: 'evaluation',
    selected: {
      text: {
        id: 'qwen3-0.6b-q8-0',
        model: 'qwen3-0.6b',
        precision: 'Q8_0',
        runtime: 'node-llama-cpp'
      },
      vision: {
        id: 'smolvlm-256m-instruct-q8',
        model: 'smolvlm-256m-instruct',
        precision: 'Q8',
        runtime: 'transformers.js'
      }
    },
    assets: [
      fileRecord({
        id: 'qwen3-weights',
        variantId: 'qwen3-0.6b-q8-0',
        component: 'weights',
        destination: 'text/qwen3-0.6b-q8-0/model.gguf'
      }),
      ...VISION_COMPONENTS.map((component) =>
        fileRecord({
          id: `smolvlm-${component}`,
          variantId: 'smolvlm-256m-instruct-q8',
          component,
          destination: `vision/smolvlm-256m-instruct-q8/${component}.bin`
        })
      )
    ],
    licenses: [
      fileRecord({
        id: 'qwen3-0.6b-apache-2.0',
        destination: 'licenses/qwen.txt'
      }),
      fileRecord({
        id: 'smolvlm-apache-2.0',
        destination: 'licenses/smolvlm.txt'
      })
    ],
    notices: []
  }
}

function mutateManifest(mutator: (value: ReturnType<typeof manifest>) => void) {
  const value = structuredClone(manifest())
  mutator(value)
  return value
}

describe('validatePackagedManifest', () => {
  it.each(['darwin-arm64', 'win32-x64'] as const)(
    'accepts the exact selected payload for %s',
    (platform) => {
      const value = manifest(platform)
      expect(
        validatePackagedManifest(value, { platform, allowEvaluation: true })
      ).toBe(value)
    }
  )

  it('accepts the other frozen catalog candidates with their exact component and license mappings', () => {
    for (const text of [
      { id: 'qwen3-1.7b-iq4-xs', precision: 'IQ4_XS' },
      { id: 'qwen3-1.7b-q4-k-m', precision: 'Q4_K_M' }
    ]) {
      const value = manifest()
      value.selected.text = {
        id: text.id,
        model: 'qwen3-1.7b',
        precision: text.precision,
        runtime: 'node-llama-cpp'
      }
      value.selected.vision = {
        id: 'florence-2-base-ft-q4',
        model: 'florence-2-base-ft',
        precision: 'q4',
        runtime: 'transformers.js'
      }
      value.assets = [
        fileRecord({
          id: `${text.id}-weights`,
          variantId: text.id,
          component: 'weights',
          destination: `text/${text.id}/model.gguf`
        }),
        ...FLORENCE_COMPONENTS.map((component) =>
          fileRecord({
            id: `florence-${component}`,
            variantId: 'florence-2-base-ft-q4',
            component,
            destination: `vision/florence-2-base-ft-q4/${component}.bin`
          })
        )
      ]
      value.licenses = [
        fileRecord({ id: 'qwen3-1.7b-apache-2.0', destination: 'licenses/qwen.txt' }),
        fileRecord({ id: 'florence-2-mit', destination: 'licenses/florence.txt' })
      ]
      expect(
        validatePackagedManifest(value, {
          platform: 'darwin-arm64',
          allowEvaluation: true
        })
      ).toBe(value)
    }
  })

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`])(
    'rejects invalid catalogSha256 %s',
    (catalogSha256) => {
      expect(() =>
        validatePackagedManifest(
          mutateManifest((value) => {
            value.catalogSha256 = catalogSha256
          }),
          { platform: 'darwin-arm64', allowEvaluation: true }
        )
      ).toThrow(/catalogSha256/i)
    }
  )

  it('requires exactly one GGUF weights asset owned by the selected text variant', () => {
    const mutations = [
      (value: ReturnType<typeof manifest>) => value.assets.shift(),
      (value: ReturnType<typeof manifest>) => value.assets.push({ ...value.assets[0], id: 'duplicate' }),
      (value: ReturnType<typeof manifest>) => {
        value.assets[0].variantId = 'unselected-text'
      },
      (value: ReturnType<typeof manifest>) => {
        value.assets[0].component = 'config'
      },
      (value: ReturnType<typeof manifest>) => {
        value.assets[0].destination = 'text/qwen3-0.6b-q8-0/model.bin'
      }
    ]
    for (const mutation of mutations) {
      expect(() =>
        validatePackagedManifest(mutateManifest(mutation), {
          platform: 'darwin-arm64',
          allowEvaluation: true
        })
      ).toThrow(/text|asset|GGUF/i)
    }
  })

  it('requires the exact vision component set owned by the selected vision variant', () => {
    const mutations = [
      (value: ReturnType<typeof manifest>) => value.assets.pop(),
      (value: ReturnType<typeof manifest>) => {
        value.assets[1].component = 'unreviewed-component'
      },
      (value: ReturnType<typeof manifest>) => {
        value.assets[1].component = value.assets[2].component
      },
      (value: ReturnType<typeof manifest>) => {
        value.assets[1].variantId = value.selected.text.id
      }
    ]
    for (const mutation of mutations) {
      expect(() =>
        validatePackagedManifest(mutateManifest(mutation), {
          platform: 'darwin-arm64',
          allowEvaluation: true
        })
      ).toThrow(/vision|asset/i)
    }
  })

  it('rejects assets belonging to an unselected variant', () => {
    const value = mutateManifest((candidate) => {
      candidate.assets.push(
        fileRecord({
          id: 'unrelated',
          variantId: 'other-model',
          component: 'weights',
          destination: 'other/model.gguf'
        })
      )
    })
    expect(() =>
      validatePackagedManifest(value, { platform: 'darwin-arm64', allowEvaluation: true })
    ).toThrow(/unselected|asset/i)
  })

  it('derives and requires exactly the licenses for the selected variants', () => {
    const mutations = [
      (value: ReturnType<typeof manifest>) => value.licenses.pop(),
      (value: ReturnType<typeof manifest>) =>
        value.licenses.push(fileRecord({ id: 'unrelated-license', destination: 'licenses/extra.txt' })),
      (value: ReturnType<typeof manifest>) => {
        value.licenses[0].id = 'qwen3-1.7b-apache-2.0'
      },
      (value: ReturnType<typeof manifest>) => {
        value.selected.text.id = 'unreviewed-text'
      }
    ]
    for (const mutation of mutations) {
      expect(() =>
        validatePackagedManifest(mutateManifest(mutation), {
          platform: 'darwin-arm64',
          allowEvaluation: true
        })
      ).toThrow(/license|selected/i)
    }
  })

  it('fails closed on evaluation payloads unless explicitly allowed', () => {
    expect(() =>
      validatePackagedManifest(manifest(), { platform: 'darwin-arm64' })
    ).toThrow(/evaluation/i)
  })
})

const WORKER_SOURCES = {
  'index.mjs': [
    "import { fileURLToPath } from 'node:url'",
    "import { createNativeRuntime } from './native-runtime.mjs'",
    "import { installNetworkDeny } from './network-deny.mjs'"
  ].join('\n'),
  'native-runtime.mjs': [
    "import { getLlama } from 'node-llama-cpp'",
    "import { realpathSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { fileURLToPath } from 'node:url'"
  ].join('\n'),
  'network-deny.mjs': [
    "import http from 'node:http'",
    "import http2 from 'node:http2'",
    "import https from 'node:https'",
    "import net from 'node:net'",
    "import tls from 'node:tls'"
  ].join('\n')
}

describe('validateWorkerSources', () => {
  it('accepts only the three reviewed workers and their exact import specifiers', () => {
    expect(validateWorkerSources(WORKER_SOURCES)).toEqual(WORKER_SOURCES)
  })

  it('rejects missing, additional, and dynamically loaded worker dependencies', () => {
    const missing = structuredClone(WORKER_SOURCES)
    missing['network-deny.mjs'] = missing['network-deny.mjs'].replace("import tls from 'node:tls'", '')
    const additional = {
      ...WORKER_SOURCES,
      'index.mjs': `${WORKER_SOURCES['index.mjs']}\nimport net from 'node:net'`
    }
    const dynamic = {
      ...WORKER_SOURCES,
      'index.mjs': `${WORKER_SOURCES['index.mjs']}\nawait import('node:https')`
    }
    expect(() => validateWorkerSources(missing)).toThrow(/import/i)
    expect(() => validateWorkerSources(additional)).toThrow(/network|import/i)
    expect(() => validateWorkerSources(dynamic)).toThrow(/dynamic|import/i)
  })

  it.each([
    'https://example.com/model.gguf',
    'provider',
    'auth',
    'credentials',
    'socket',
    'server',
    'resolveModelFile'
  ])('rejects forbidden worker source token %s', (token) => {
    expect(() =>
      validateWorkerSources({
        ...WORKER_SOURCES,
        'index.mjs': `${WORKER_SOURCES['index.mjs']}\n// ${token}`
      })
    ).toThrow(/forbidden/i)
  })
})

function asarEntries(platform: 'darwin-arm64' | 'win32-x64') {
  const nativePackages =
    platform === 'darwin-arm64' ? ['mac-arm64-metal'] : ['win-x64', 'win-x64-vulkan']
  return [
    'out/local-ai-worker',
    'out/local-ai-worker/index.mjs',
    'out/local-ai-worker/native-runtime.mjs',
    'out/local-ai-worker/network-deny.mjs',
    'node_modules/node-llama-cpp/dist/index.js',
    'node_modules/node-llama-cpp/package.json',
    'node_modules/node-llama-cpp/llama/binariesGithubRelease.json',
    'node_modules/node-llama-cpp/llama/llama.cpp.info.json',
    'node_modules/node-llama-cpp/llama/package.json',
    'node_modules/node-llama-cpp/llama/grammars/json.gbnf',
    'node_modules/lifecycle-utils/package.json',
    ...nativePackages.flatMap((name) => [
      `node_modules/@node-llama-cpp/${name}/dist/index.js`,
      `node_modules/@node-llama-cpp/${name}/package.json`
    ])
  ]
}

describe('validatePackagedAsarEntries', () => {
  it.each(['darwin-arm64', 'win32-x64'] as const)(
    'accepts the exact worker set and runtime-only node-llama tree for %s',
    (platform) => {
      const entries = asarEntries(platform)
      expect(validatePackagedAsarEntries(entries, platform)).toEqual(new Set(entries))
    }
  )

  it('rejects additional worker output', () => {
    expect(() =>
      validatePackagedAsarEntries(
        [...asarEntries('darwin-arm64'), 'out/local-ai-worker/stale.mjs'],
        'darwin-arm64'
      )
    ).toThrow(/worker/i)
  })

  it.each([
    'node_modules/node-llama-cpp/llama/llama.cpp.info.json',
    'node_modules/node-llama-cpp/llama/package.json'
  ])('requires node-llama runtime metadata %s', (required) => {
    expect(() =>
      validatePackagedAsarEntries(
        asarEntries('darwin-arm64').filter((entry) => entry !== required),
        'darwin-arm64'
      )
    ).toThrow(/missing ASAR entry/i)
  })

  it.each([
    'addon/source.cpp',
    'cmake/tool.cmake',
    'gpuInfo/source.cpp',
    'patches/build.patch',
    'profiles/default.json',
    'toolchains/arm64.cmake',
    'xpack/tool',
    'gitRelease.bundle',
    'CMakeLists.txt',
    '.clang-format'
  ])('rejects packaged node-llama source/build path %s', (suffix) => {
    expect(() =>
      validatePackagedAsarEntries(
        [...asarEntries('darwin-arm64'), `node_modules/node-llama-cpp/llama/${suffix}`],
        'darwin-arm64'
      )
    ).toThrow(/source|build|forbidden/i)
  })
})

function sherpaPackages(platform: 'darwin-arm64' | 'win32-x64') {
  const native = platform === 'darwin-arm64' ? 'sherpa-onnx-darwin-arm64' : 'sherpa-onnx-win-x64'
  return {
    'sherpa-onnx-node': [{ path: 'package.json', bytes: 1, nlink: 1 }],
    [native]: [
      { path: 'package.json', bytes: 1, nlink: 1 },
      { path: 'sherpa-onnx.node', bytes: 1024, nlink: 1 }
    ]
  }
}

describe('validateSherpaPackages', () => {
  it.each(['darwin-arm64', 'win32-x64'] as const)(
    'accepts exactly the generic and native Sherpa packages for %s',
    (platform) => {
      const packages = sherpaPackages(platform)
      expect(validateSherpaPackages(platform, packages)).toEqual(packages)
    }
  )

  it('rejects a cross-platform or additional Sherpa package', () => {
    const packages = {
      ...sherpaPackages('darwin-arm64'),
      'sherpa-onnx-win-x64': [{ path: 'sherpa-onnx.node', bytes: 1, nlink: 1 }]
    }
    expect(() => validateSherpaPackages('darwin-arm64', packages)).toThrow(/Sherpa package/i)
  })

  it('requires a nonempty, regular native addon', () => {
    const packages = sherpaPackages('win32-x64')
    packages['sherpa-onnx-win-x64'][1].bytes = 0
    expect(() => validateSherpaPackages('win32-x64', packages)).toThrow(/native addon/i)
  })
})
