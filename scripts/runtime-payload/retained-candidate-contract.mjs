// Closed contract for the exact retained publisher run; no filesystem or process effects.
import { createHash } from 'node:crypto'

const MAX_SOURCE_LOCK_BYTES = 20_000_000

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  )
}

const MAX_JSON_BYTES = 20_000_000
const MAX_JSON_DEPTH = 128
const MAX_JSON_NODES = 1_000_000

class JsonReader {
  constructor(text, maxDepth, maxNodes) {
    this.text = text
    this.offset = 0
    this.maxDepth = maxDepth
    this.maxNodes = maxNodes
    this.nodes = 0
  }

  whitespace() {
    while (/[\u0009\u000a\u000d\u0020]/.test(this.text[this.offset] ?? '')) this.offset += 1
  }

  string() {
    const start = this.offset
    this.offset += 1
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset)
      if (code === 0x22) {
        this.offset += 1
        const token = this.text.slice(start, this.offset)
        let decoded = ''
        for (let cursor = 1; cursor < token.length - 1; cursor += 1) {
          const character = token[cursor]
          if (character !== '\\') {
            decoded += character
            continue
          }
          const escaped = token[++cursor]
          const simpleEscapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
          if (escaped === 'u') {
            decoded += String.fromCharCode(Number.parseInt(token.slice(cursor + 1, cursor + 5), 16))
            cursor += 4
          } else decoded += simpleEscapes[escaped]
        }
        return decoded
      }
      if (code < 0x20) throw new SyntaxError('Invalid JSON string')
      if (code === 0x5c) {
        this.offset += 1
        const escaped = this.text[this.offset]
        if (!escaped || !'"\\/bfnrtu'.includes(escaped)) throw new SyntaxError('Invalid JSON escape')
        if (escaped === 'u') {
          const digits = this.text.slice(this.offset + 1, this.offset + 5)
          if (!/^[a-fA-F0-9]{4}$/.test(digits)) throw new SyntaxError('Invalid JSON unicode escape')
          this.offset += 4
        }
      }
      this.offset += 1
    }
    throw new SyntaxError('Unterminated JSON string')
  }

  value(depth = 0) {
    this.whitespace()
    if (depth > this.maxDepth || ++this.nodes > this.maxNodes) throw new RangeError('JSON complexity limit exceeded')
    const token = this.text[this.offset]
    if (token === '{') return this.object(depth)
    if (token === '[') return this.array(depth)
    if (token === '"') return this.string()
    if (token === 't' && this.text.startsWith('true', this.offset)) {
      this.offset += 4
      return true
    }
    if (token === 'f' && this.text.startsWith('false', this.offset)) {
      this.offset += 5
      return false
    }
    if (token === 'n' && this.text.startsWith('null', this.offset)) {
      this.offset += 4
      return null
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.offset))
    if (match) {
      this.offset += match[0].length
      const number = Number(match[0])
      if (!Number.isFinite(number)) throw new SyntaxError('Nonfinite JSON number')
      return number
    }
    throw new SyntaxError('Invalid JSON value')
  }

  object(depth) {
    this.offset += 1
    const result = {}
    const keys = new Set()
    this.whitespace()
    if (this.text[this.offset] === '}') {
      this.offset += 1
      return result
    }
    while (true) {
      this.whitespace()
      if (this.text[this.offset] !== '"') throw new SyntaxError('Expected JSON object key')
      const key = this.string()
      if (keys.has(key)) throw new SyntaxError('Duplicate JSON object key')
      keys.add(key)
      this.whitespace()
      if (this.text[this.offset] !== ':') throw new SyntaxError('Expected JSON key separator')
      this.offset += 1
      const entry = this.value(depth + 1)
      Object.defineProperty(result, key, { value: entry, enumerable: true, writable: true, configurable: true })
      this.whitespace()
      const separator = this.text[this.offset]
      if (separator === '}') {
        this.offset += 1
        return result
      }
      if (separator !== ',') throw new SyntaxError('Expected JSON object separator')
      this.offset += 1
    }
  }

  array(depth) {
    this.offset += 1
    const result = []
    this.whitespace()
    if (this.text[this.offset] === ']') {
      this.offset += 1
      return result
    }
    while (true) {
      result.push(this.value(depth + 1))
      this.whitespace()
      const separator = this.text[this.offset]
      if (separator === ']') {
        this.offset += 1
        return result
      }
      if (separator !== ',') throw new SyntaxError('Expected JSON array separator')
      this.offset += 1
    }
  }
}

export function parseStrictJsonBytes(bytes, limits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_JSON_BYTES
  const maxDepth = limits.maxDepth ?? MAX_JSON_DEPTH
  const maxNodes = limits.maxNodes ?? MAX_JSON_NODES
  if (
    !(bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    bytes.byteLength > maxBytes
  )
    throw new RangeError('JSON byte or complexity limit exceeded')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const reader = new JsonReader(text, maxDepth, maxNodes)
  const value = reader.value()
  reader.whitespace()
  if (reader.offset !== text.length) throw new SyntaxError('Trailing JSON data')
  return value
}

export function sourceLockDigests(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SOURCE_LOCK_BYTES) return null
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!bytes.includes(0x0a) || bytes.includes(0x0d)) return null
  return {
    canonicalLfSha256: createHash('sha256').update(bytes).digest('hex'),
    exactCrlfProjectionSha256: createHash('sha256')
      .update(new TextEncoder().encode(text.replace(/\n/g, '\r\n')))
      .digest('hex')
  }
}

export const SOURCE_SHA = '613d7886504f608766022fa740b1ed7297e17b16'
export const SOURCE_REF = 'refs/heads/m2/M2-0475-runtime-artifact-publisher'
export const WORKFLOW_PATH = '.github/workflows/runtime-llama-candidate.yml'
export const RUN_ID = '38626866933'
export const RUN_ATTEMPT = 1
export const REPOSITORY_URI = 'https://github.com/mysticalsin/AskToto-Mantu'
export const REPOSITORY_ID = '1282463398'
export const NATIVE_TARGETS = Object.freeze([
  { platform: 'darwin', arch: 'arm64', suffix: 'darwin-arm64' },
  { platform: 'darwin', arch: 'x64', suffix: 'darwin-x64' },
  { platform: 'win32', arch: 'x64', suffix: 'win32-x64' }
])
export const MODEL = Object.freeze({
  id: 'qwen3.5-0.8b',
  artifactId: 'model.qwen3.5-0.8b',
  archive: 'model.qwen3.5-0.8b.tar.gz',
  inventory: 'model.qwen3.5-0.8b.inventory.json',
  bundle: 'model.qwen3.5-0.8b.sigstore.bundle.json',
  root: 'models/qwen3.5-0.8b',
  members: ['models/qwen3.5-0.8b/mmproj.gguf', 'models/qwen3.5-0.8b/model.gguf']
})
export const MODEL_REVISION = '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0'
export const MODEL_FILES = Object.freeze([
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
])
export const MODEL_PAYLOAD_BYTES = 763_771_056
export const LLAMA_COMMIT = 'c4ae9a88f8884ee5a155c8349ace9ea31a58007f'
export const LLAMA_LICENSE_SHA256 = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
export const LLAMA_UPSTREAM = Object.freeze({
  'darwin-arm64': '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f',
  'darwin-x64': 'f03f6669c7e34c2768ca4a318dd13e105dec46e1f87a2165d2be7fd6a0ee4716',
  'win32-x64': '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79'
})

export function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((part) => {
      if (part === '' || part === '.' || part === '..' || part.endsWith('.') || !/^[A-Za-z0-9._@+-]+$/.test(part))
        return false
      return !/^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i.test(part.split('.')[0])
    })
  )
}

export function validSource(source, expectedLockSha256) {
  return (
    record(source) &&
    exactKeys(source, [
      'repositoryUri',
      'commit',
      'workflowPath',
      'workflowCommit',
      'runId',
      'attempt',
      'lockSha256',
      'ref',
      'runnerEnvironment'
    ]) &&
    source.repositoryUri === REPOSITORY_URI &&
    source.commit === SOURCE_SHA &&
    source.workflowPath === WORKFLOW_PATH &&
    source.workflowCommit === SOURCE_SHA &&
    source.runId === RUN_ID &&
    source.attempt === RUN_ATTEMPT &&
    source.lockSha256 &&
    /^[a-f0-9]{64}$/.test(source.lockSha256) &&
    (expectedLockSha256 === undefined || source.lockSha256 === expectedLockSha256) &&
    source.ref === SOURCE_REF &&
    source.runnerEnvironment === 'github-hosted'
  )
}

export function validBuilder(builder) {
  return (
    record(builder) &&
    exactKeys(builder, ['nodeVersion', 'npmVersion', 'zlibVersion', 'packages']) &&
    builder.nodeVersion === 'v22.22.3' &&
    typeof builder.npmVersion === 'string' &&
    /^\d+\.\d+\.\d+$/.test(builder.npmVersion) &&
    typeof builder.zlibVersion === 'string' &&
    builder.zlibVersion.length > 0 &&
    builder.zlibVersion.length <= 64 &&
    Array.isArray(builder.packages) &&
    builder.packages.length === 1 &&
    exactKeys(builder.packages[0], ['name', 'version']) &&
    builder.packages[0].name === 'electron' &&
    builder.packages[0].version === '43.6.0'
  )
}

export function validRuntimeFacts(runtime) {
  return (
    record(runtime) &&
    exactKeys(runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol']) &&
    runtime.electronVersion === '43.6.0' &&
    /^\d{1,8}$/.test(runtime.nodeAbi) &&
    /^\d{1,8}$/.test(runtime.napi) &&
    /^\d+\.\d+\.\d+\.\d+$/.test(runtime.chromiumVersion) &&
    runtime.hostProtocol === 1
  )
}

export function validFileRows(files, expectedRows, allowNativeRuntime = false) {
  if (!Array.isArray(files) || files.length !== expectedRows.length) return false
  let prior = ''
  const paths = new Set()
  const folded = new Set()
  for (let index = 0; index < files.length; index += 1) {
    const file = record(files[index])
    const expected = expectedRows[index]
    if (
      !file ||
      !exactKeys(file, ['path', 'bytes', 'sha256', 'executable']) ||
      !safeRelativePath(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.executable !== 'boolean' ||
      file.path <= prior ||
      paths.has(file.path) ||
      folded.has(file.path.toLowerCase())
    )
      return false
    if (expected) {
      if (
        file.path !== expected.path ||
        file.bytes !== expected.bytes ||
        file.sha256 !== expected.sha256 ||
        file.executable !== expected.executable
      )
        return false
    } else if (!allowNativeRuntime || !file.path.startsWith('runtime/')) return false
    prior = file.path
    paths.add(file.path)
    folded.add(file.path.toLowerCase())
  }
  return true
}

export function validNativeReceipts(inventory, target) {
  const upstreamDigest = LLAMA_UPSTREAM[target.suffix]
  const upstream =
    Array.isArray(inventory.upstream) && inventory.upstream.length === 1 ? record(inventory.upstream[0]) : null
  const upstreamSource = `https://github.com/ggml-org/llama.cpp/releases/download/b9957/${
    target.platform === 'win32' ? 'llama-b9957-bin-win-cpu-x64.zip' : `llama-b9957-bin-macos-${target.arch}.tar.gz`
  }`
  const license =
    Array.isArray(inventory.licenses) && inventory.licenses.length === 1 ? record(inventory.licenses[0]) : null
  const notice = Array.isArray(inventory.files)
    ? inventory.files.find((file) => record(file)?.path === 'licenses/llama.cpp-LICENSE.txt')
    : null
  return (
    upstreamDigest &&
    upstream &&
    exactKeys(upstream, ['name', 'version', 'sourceUri', 'revision', 'digest']) &&
    upstream.name === 'llama.cpp prebuilt native server archive' &&
    upstream.version === 'b9957' &&
    upstream.sourceUri === upstreamSource &&
    upstream.revision === LLAMA_COMMIT &&
    exactKeys(upstream.digest, ['algorithm', 'value']) &&
    upstream.digest.algorithm === 'sha256' &&
    upstream.digest.value === upstreamDigest &&
    license &&
    exactKeys(license, [
      'package',
      'version',
      'spdx',
      'sourceUri',
      'noticePath',
      'noticeBytes',
      'noticeSha256',
      'sourceReceiptUri'
    ]) &&
    license.package === 'llama.cpp' &&
    license.version === 'b9957' &&
    license.spdx === 'MIT' &&
    license.sourceUri === 'https://github.com/ggml-org/llama.cpp' &&
    license.noticePath === 'licenses/llama.cpp-LICENSE.txt' &&
    license.noticeBytes === 1078 &&
    license.noticeSha256 === LLAMA_LICENSE_SHA256 &&
    license.sourceReceiptUri === `https://github.com/ggml-org/llama.cpp/blob/${LLAMA_COMMIT}/LICENSE` &&
    record(notice)?.bytes === 1078 &&
    notice.sha256 === LLAMA_LICENSE_SHA256 &&
    notice.executable === false
  )
}

export function validModelReceipts(inventory) {
  const upstream = Array.isArray(inventory.upstream) ? inventory.upstream : []
  const licenses = Array.isArray(inventory.licenses) ? inventory.licenses : []
  const expectedUpstream = [
    {
      name: 'Qwen3.5 0.8B model.gguf',
      sourceUri:
        'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-UD-Q4_K_XL.gguf',
      digest: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5'
    },
    {
      name: 'Qwen3.5 0.8B mmproj.gguf',
      sourceUri:
        'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf',
      digest: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453'
    }
  ]
  const validUpstream =
    upstream.length === expectedUpstream.length &&
    new Set(upstream.map((item) => record(item)?.name)).size === expectedUpstream.length &&
    expectedUpstream.every((expected) => {
      const item = upstream.find((raw) => record(raw)?.name === expected.name)
      return (
        record(item) &&
        exactKeys(item, ['name', 'version', 'sourceUri', 'revision', 'digest']) &&
        item.version === MODEL_REVISION &&
        item.sourceUri === expected.sourceUri &&
        item.revision === MODEL_REVISION &&
        exactKeys(item.digest, ['algorithm', 'value']) &&
        item.digest.algorithm === 'sha256' &&
        item.digest.value === expected.digest
      )
    })
  const license = licenses.length === 1 ? record(licenses[0]) : null
  const notice = Array.isArray(inventory.files)
    ? inventory.files.find((file) => record(file)?.path === MODEL_FILES[0].path)
    : null
  return (
    validUpstream &&
    license &&
    exactKeys(license, [
      'package',
      'version',
      'spdx',
      'sourceUri',
      'noticePath',
      'noticeBytes',
      'noticeSha256',
      'sourceReceiptUri'
    ]) &&
    license.package === 'Qwen3.5-0.8B-GGUF' &&
    license.version === MODEL_REVISION &&
    license.spdx === 'Apache-2.0' &&
    license.sourceUri === 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF' &&
    license.noticePath === MODEL_FILES[0].path &&
    license.noticeBytes === MODEL_FILES[0].bytes &&
    license.noticeSha256 === MODEL_FILES[0].sha256 &&
    license.sourceReceiptUri ===
      `https://github.com/mysticalsin/AskToto-Mantu/blob/${SOURCE_SHA}/resources/local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt` &&
    record(notice)?.bytes === MODEL_FILES[0].bytes &&
    notice.sha256 === MODEL_FILES[0].sha256 &&
    notice.executable === false
  )
}

export function validModelInventory(inventory) {
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'componentId',
    'artifactId',
    'target',
    'runtime',
    'entrypoints',
    'directories',
    'models',
    'source',
    'builder',
    'upstream',
    'files',
    'licenses'
  ]
  const model = Array.isArray(inventory?.models) && inventory.models.length === 1 ? record(inventory.models[0]) : null
  return Boolean(
    record(inventory) &&
      exactKeys(inventory, expectedKeys) &&
      inventory.schemaVersion === 1 &&
      inventory.kind === 'model' &&
      inventory.componentId === MODEL.artifactId &&
      inventory.artifactId === MODEL.artifactId &&
      exactKeys(inventory.target, ['platform', 'arch']) &&
      inventory.target.platform === 'any' &&
      inventory.target.arch === 'any' &&
      inventory.runtime === null &&
      exactKeys(inventory.entrypoints, []) &&
      exactKeys(inventory.directories, []) &&
      model &&
      exactKeys(model, ['id', 'root', 'members']) &&
      model.id === MODEL.id &&
      model.root === MODEL.root &&
      Array.isArray(model.members) &&
      model.members.join('\0') === MODEL.members.join('\0') &&
      validSource(inventory.source) &&
      validBuilder(inventory.builder) &&
      validFileRows(inventory.files, MODEL_FILES) &&
      inventory.files.reduce((total, file) => total + file.bytes, 0) === MODEL_PAYLOAD_BYTES &&
      validModelReceipts(inventory)
  )
}
