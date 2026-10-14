import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  expectedSourceLockSha256,
  NATIVE_TARGETS,
  parseStrictJsonBytes,
  safeRelativePath,
  sourceLockDigests,
  validFileRows,
  validModelInventory,
  validNativeReceipts,
  validSource
} from './retained-candidate-contract.mjs'

const source = {
  repositoryUri: 'https://github.com/mysticalsin/AskToto-Mantu',
  commit: '613d7886504f608766022fa740b1ed7297e17b16',
  workflowPath: '.github/workflows/runtime-llama-candidate.yml',
  workflowCommit: '613d7886504f608766022fa740b1ed7297e17b16',
  runId: '38626866933',
  attempt: 1,
  lockSha256: 'a'.repeat(64),
  ref: 'refs/heads/m2/M2-0475-runtime-artifact-publisher',
  runnerEnvironment: 'github-hosted'
}

const files = [
  {
    path: 'licenses/QWEN3.5-APACHE-2.0.txt',
    bytes: 11_344,
    sha256: '2410613f992aef11cab1ca584d5732068b6038da37bd140092f09f61dd1c31bd',
    executable: false
  },
  {
    path: 'models/qwen3.5-0.8b/mmproj.gguf',
    bytes: 204_987_232,
    sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453',
    executable: false
  },
  {
    path: 'models/qwen3.5-0.8b/model.gguf',
    bytes: 558_772_480,
    sha256: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5',
    executable: false
  }
]

function inventory() {
  return {
    schemaVersion: 1,
    kind: 'model',
    componentId: 'model.qwen3.5-0.8b',
    artifactId: 'model.qwen3.5-0.8b',
    target: { platform: 'any', arch: 'any' },
    runtime: null,
    entrypoints: {},
    directories: {},
    models: [
      {
        id: 'qwen3.5-0.8b',
        root: 'models/qwen3.5-0.8b',
        members: ['models/qwen3.5-0.8b/mmproj.gguf', 'models/qwen3.5-0.8b/model.gguf']
      }
    ],
    source: { ...source },
    builder: {
      nodeVersion: 'v22.22.3',
      npmVersion: '10.9.4',
      zlibVersion: '1.3.1',
      packages: [{ name: 'electron', version: '43.6.0' }]
    },
    upstream: [
      {
        name: 'Qwen3.5 0.8B model.gguf',
        version: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
        sourceUri:
          'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-UD-Q4_K_XL.gguf',
        revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
        digest: { algorithm: 'sha256', value: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5' }
      },
      {
        name: 'Qwen3.5 0.8B mmproj.gguf',
        version: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
        sourceUri:
          'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf',
        revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
        digest: { algorithm: 'sha256', value: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453' }
      }
    ],
    files: files.map((file) => ({ ...file })),
    licenses: [
      {
        package: 'Qwen3.5-0.8B-GGUF',
        version: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
        spdx: 'Apache-2.0',
        sourceUri: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF',
        noticePath: files[0].path,
        noticeBytes: files[0].bytes,
        noticeSha256: files[0].sha256,
        sourceReceiptUri:
          'https://github.com/mysticalsin/AskToto-Mantu/blob/613d7886504f608766022fa740b1ed7297e17b16/resources/local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt'
      }
    ]
  }
}

test('synthetic pinned model inventory exercises verifier plumbing only', () => {
  assert.equal(validModelInventory(inventory()), true)
  assert.equal(validSource(source, 'a'.repeat(64)), true)
  assert.equal(validSource(source, 'b'.repeat(64)), false)
})

test('strict byte parser accepts producer JSON formatting and arbitrary valid field order', () => {
  const producerBytes = new TextEncoder().encode(`${JSON.stringify(inventory(), null, 2)}\n`)
  assert.deepEqual(parseStrictJsonBytes(producerBytes), inventory())
  assert.deepEqual(
    parseStrictJsonBytes(new TextEncoder().encode(' { "b" : [true, null, -2.5e+3], "a" : "\\u0061" } ')),
    {
      b: [true, null, -2500],
      a: 'a'
    }
  )
})

test('strict byte parser rejects duplicate keys at every nesting level, including escaped aliases', () => {
  const cases = [
    '{"schemaVersion":1,"kind":"model","kind":"runtime"}',
    '{"source":{"commit":"first","commit":"second"}}',
    '{"subject":[{"digest":{"sha256":"first","sha256":"second"}}]}',
    '{"mediaType":"bundle","mediaType":"other"}',
    String.raw`{"outer":{"name":1,"\u006eame":2}}`
  ]
  for (const raw of cases) assert.throws(() => parseStrictJsonBytes(new TextEncoder().encode(raw)))
})

test('strict byte parser rejects invalid UTF-8, BOM, oversized input and excessive complexity', () => {
  assert.throws(() => parseStrictJsonBytes(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d])))
  assert.throws(() => parseStrictJsonBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])))
  assert.throws(() => parseStrictJsonBytes(new TextEncoder().encode('{}'), { maxBytes: 1 }))
  assert.throws(() => parseStrictJsonBytes(new TextEncoder().encode('[[[]]]'), { maxDepth: 1 }))
  assert.throws(() => parseStrictJsonBytes(new TextEncoder().encode('[0]'), { maxNodes: 1 }))
  for (const raw of ['01', '1.', 'NaN', '1e9999', '[1,]'])
    assert.throws(() => parseStrictJsonBytes(new TextEncoder().encode(raw)))
})

test('rejects model identity, root traversal, and arbitrary member substitution', () => {
  const badId = inventory()
  badId.models[0].id = 'attacker-model'
  assert.equal(validModelInventory(badId), false)

  const traversal = inventory()
  traversal.models[0].root = '../models/qwen3.5-0.8b'
  assert.equal(validModelInventory(traversal), false)

  const changedMember = inventory()
  changedMember.models[0].members[1] = 'models/qwen3.5-0.8b/../../outside.gguf'
  assert.equal(validModelInventory(changedMember), false)
})

test('rejects equal-hash substitution, root files, and changed license notice receipt', () => {
  const changedModelHash = inventory()
  changedModelHash.files[1].sha256 = changedModelHash.files[2].sha256
  assert.equal(validModelInventory(changedModelHash), false)

  const rootFile = inventory()
  rootFile.files[0].path = 'model.gguf'
  assert.equal(validModelInventory(rootFile), false)

  const changedNotice = inventory()
  changedNotice.licenses[0].noticeBytes += 1
  assert.equal(validModelInventory(changedNotice), false)

  const duplicateUpstream = inventory()
  duplicateUpstream.upstream[1] = { ...duplicateUpstream.upstream[0] }
  assert.equal(validModelInventory(duplicateUpstream), false)
})

test('rejects traversal and platform-ambiguous path components', () => {
  assert.equal(safeRelativePath('../escape'), false)
  assert.equal(safeRelativePath('models/qwen/../../escape'), false)
  assert.equal(safeRelativePath('models/CON/model.gguf'), false)
  assert.equal(safeRelativePath('models/qwen/model.gguf'), true)
  assert.equal(validFileRows(files, files), true)
})

function nativeInventory() {
  return {
    files: [
      {
        path: 'licenses/llama.cpp-LICENSE.txt',
        bytes: 1078,
        sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
        executable: false
      },
      { path: 'runtime/llama-server', bytes: 12, sha256: 'c'.repeat(64), executable: true }
    ],
    upstream: [
      {
        name: 'llama.cpp prebuilt native server archive',
        version: 'b9957',
        sourceUri: 'https://github.com/ggml-org/llama.cpp/releases/download/b9957/llama-b9957-bin-macos-arm64.tar.gz',
        revision: 'c4ae9a88f8884ee5a155c8349ace9ea31a58007f',
        digest: {
          algorithm: 'sha256',
          value: '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f'
        }
      }
    ],
    licenses: [
      {
        package: 'llama.cpp',
        version: 'b9957',
        spdx: 'MIT',
        sourceUri: 'https://github.com/ggml-org/llama.cpp',
        noticePath: 'licenses/llama.cpp-LICENSE.txt',
        noticeBytes: 1078,
        noticeSha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
        sourceReceiptUri: 'https://github.com/ggml-org/llama.cpp/blob/c4ae9a88f8884ee5a155c8349ace9ea31a58007f/LICENSE'
      }
    ]
  }
}

test('accepts synthetic pinned native closure and rejects substituted upstream or notice pins', () => {
  const valid = nativeInventory()
  const expectedLicense = { ...valid.files[0] }
  const expectedRows = [expectedLicense, null]
  assert.equal(validNativeReceipts(valid, NATIVE_TARGETS[0]), true)
  assert.equal(validFileRows(valid.files, expectedRows, true), true)

  const wrongUpstream = nativeInventory()
  wrongUpstream.upstream[0].digest.value = 'a'.repeat(64)
  assert.equal(validNativeReceipts(wrongUpstream, NATIVE_TARGETS[0]), false)

  const wrongNotice = nativeInventory()
  wrongNotice.files[0].sha256 = 'b'.repeat(64)
  assert.equal(validNativeReceipts(wrongNotice, NATIVE_TARGETS[0]), false)
  assert.equal(validFileRows(wrongNotice.files, expectedRows, true), false)
})

test('compares exact CRLF projection only for canonical UTF-8 LF lock bytes', () => {
  const encoder = new TextEncoder()
  const lockText = '{"lockfileVersion":3,\n"packages":{"node_modules/example":{"version":"1.0.0"}}}\n'
  const lfBytes = encoder.encode(lockText)
  const lfSha256 = createHash('sha256').update(lfBytes).digest('hex')
  const crlfSha256 = createHash('sha256')
    .update(encoder.encode(lockText.replace(/\n/g, '\r\n')))
    .digest('hex')
  const digests = sourceLockDigests(lfBytes)
  assert.deepEqual(digests, { canonicalLfSha256: lfSha256, exactCrlfProjectionSha256: crlfSha256 })
  assert.notEqual(digests.canonicalLfSha256, digests.exactCrlfProjectionSha256)

  const changedDependency = encoder.encode(lockText.replace('"1.0.0"', '"1.0.1"'))
  const changedDigests = sourceLockDigests(changedDependency)
  assert.notEqual(changedDigests.canonicalLfSha256, digests.canonicalLfSha256)
  assert.notEqual(changedDigests.exactCrlfProjectionSha256, digests.exactCrlfProjectionSha256)

  assert.equal(sourceLockDigests(encoder.encode(lockText.replace(/\n/g, '\r\n'))), null)
  assert.equal(sourceLockDigests(Uint8Array.from([0x7b, 0xff, 0x0a])), null)
  assert.equal(sourceLockDigests(encoder.encode('{"lockfileVersion":3}')), null)
})

test('selects one exact source-lock digest per closed target and rejects cross-target or changed content', () => {
  const encoder = new TextEncoder()
  const lockText = '{"lockfileVersion":3,\n"packages":{"node_modules/example":{"version":"1.0.0"}}}\n'
  const digests = sourceLockDigests(encoder.encode(lockText))
  const changedDigests = sourceLockDigests(encoder.encode(lockText.replace('"1.0.0"', '"1.0.1"')))
  assert.ok(digests)
  assert.ok(changedDigests)
  if (!digests || !changedDigests) throw new Error('Synthetic lock fixtures must be canonical UTF-8 LF.')
  assert.notEqual(changedDigests.canonicalLfSha256, digests.canonicalLfSha256)
  assert.notEqual(changedDigests.exactCrlfProjectionSha256, digests.exactCrlfProjectionSha256)

  expectTargetLockSource('darwin-arm64', digests, digests.canonicalLfSha256, changedDigests)
  expectTargetLockSource('darwin-x64', digests, digests.canonicalLfSha256, changedDigests)
  expectTargetLockSource('win32-x64', digests, digests.exactCrlfProjectionSha256, changedDigests)
  assert.equal(expectedSourceLockSha256('linux-x64', digests), null)
})

function expectTargetLockSource(targetSuffix, digests, expectedDigest, changedDigests) {
  const lfSource = { ...source, lockSha256: digests.canonicalLfSha256 }
  const crlfSource = { ...source, lockSha256: digests.exactCrlfProjectionSha256 }
  const correctSource = targetSuffix === 'win32-x64' ? crlfSource : lfSource
  const crossTargetSource = targetSuffix === 'win32-x64' ? lfSource : crlfSource
  assert.equal(expectedSourceLockSha256(targetSuffix, digests), expectedDigest)
  assert.equal(validSource(correctSource, expectedSourceLockSha256(targetSuffix, digests)), true)
  assert.equal(validSource(crossTargetSource, expectedSourceLockSha256(targetSuffix, digests)), false)
  assert.equal(
    validSource(correctSource, expectedSourceLockSha256(targetSuffix, changedDigests)),
    false,
    `${targetSuffix} must reject a lock digest derived from changed dependency content`
  )
}
