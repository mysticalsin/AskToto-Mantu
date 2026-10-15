#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareInventories, validateGraph } from './renderer-katex-build-evidence.mjs'

const BASE = '15fcfa376feda44531596218a3751c6ea37f98ef'
const DEPENDENCY_BASELINE = 'cf2889b0c46b001140b7ccd346ffa6010eeec7a1'
const DEPENDENCY_COMMIT = 'af7da32a46e2edb084c70f41823e7df48a13df9a'
const REMEDIATION_BRANCH = 'fix/renderer-katex-remediation'
const APPROVED_REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REMEDIATION_PACKAGE_HASHES = Object.freeze({
  'package.json': '587bae986ba457a255a7e52943586401327e3c5c6c9ae1a32f6d120a3bdf280e',
  'package-lock.json': 'a381ca5f8cce8042c5fca6a8aaf256e97c5a9c5540a0bb9abd149b10b7d07ced'
})
const REMEDIATION_FILES = Object.freeze([
  '.github/workflows/renderer-katex-security.yml',
  'scripts/ci/renderer-katex-provenance.mjs',
  'scripts/ci/renderer-katex-build-evidence.mjs',
  'scripts/ci/renderer-katex-shipping-evidence.mjs',
  'scripts/ci/renderer-katex-evidence.test.ts',
  'src/renderer/src/components/Markdown.katex.browser.test.ts',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts'
])
const EVIDENCE_TEST_PATH = 'scripts/ci/renderer-katex-evidence.test.ts'
const EVIDENCE_TEST_COUNT = 14
const GREEN_SUITE_COUNT = 10
export const EVIDENCE_CASES = Object.freeze([
  'accepts exact ordinary/observed byte identity and rejects changed, duplicate, or incomplete files',
  'requires complete static, dynamic, asset, and worker output membership in the production graph',
  'resolves local HTML, CSS, and source-map references against the complete output inventory',
  'accepts measured full and lean build profiles only with a real Markdown graph and byte-identical outputs',
  'rejects a renamed old KaTeX bundle and old-source map content by bytes and signature',
  'accepts the exact 30-title GREEN roster and rejects wrong counts, title grafts, pending work, and retries',
  'rejects a wrong file/title identity and a file-level hook error even when summary counts claim 30/30',
  'requires current-attempt unhandled-error identity and rejects missing or duplicate browser origins',
  'requires zero-exit full audit and a complete npm 10.9.8 CycloneDX lock graph',
  'binds the exact KaTeX lock fix while rejecting an alternate KaTeX identity, duplicate copy, or unrelated lock churn',
  'requires npm ls and npm explain to agree on one installed patched KaTeX and rejects malformed or stale evidence',
  'reads a real packed and unpacked ASAR and qualifies only a candidate app tree',
  'rejects a build/package byte mismatch, missing delivered license material, and a renamed old bundle in loose resources',
  'finds an old KaTeX source map inside the actual ASAR instead of trusting its filename'
])
const PATCHED_KATEX = Object.freeze({
  version: '0.18.2',
  resolved: 'https://registry.npmjs.org/katex/-/katex-0.18.2.tgz',
  integrity: 'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA=='
})
const HARNESS_BASELINE = 'c7901c5551c820171401ff4669b5af4b394eb5b9'
const IMAGE_POLICY_COMMIT = '0b10ac4badd4811685bb376f1a6ee8aab8212490'
const IMAGE_POLICY_PATH = 'src/renderer/src/components/Markdown.tsx'
const IMAGE_POLICY_SHA256 = '5f1d8910947f5b33de58b759d7bebf72088c1dfab26d013a8c9724640a62d994'
const HARNESS_BASELINE_FILES = Object.freeze([
  '.github/workflows/renderer-katex-security.yml',
  'scripts/ci/renderer-katex-provenance.mjs',
  'scripts/ci/renderer-katex-unhandled-reporter.mjs',
  'src/renderer/src/components/Markdown.katex.browser.test.ts',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
  'src/renderer/src/components/Markdown.security.browser.test.ts',
  'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
])
const HARNESS_REPAIR_FILES = Object.freeze([
  '.github/workflows/renderer-katex-security.yml',
  'scripts/ci/renderer-katex-provenance.mjs',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
  'src/renderer/src/components/Markdown.security.browser.test.ts',
  'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
])
const BASE_HASHES = Object.freeze({
  'package.json': '143e15a11a6b4285a02cb385a0701e85e2a001c0b2b0ed8560283ef12e938122',
  'package-lock.json': '88425a099d638387d1bf14fd06348002e3ced36f29ca25296d00f7e5b92b0393'
})
const OLD_KATEX = Object.freeze({
  version: '0.16.47',
  resolved: 'https://registry.npmjs.org/katex/-/katex-0.16.47.tgz',
  integrity: 'sha512-Eeo8Ys1doU1z+x8AZsPpQu+p/QcZBI5PeOo7QGQdy2x2m0MU/hYagBbGOmXwr5KVbEfVuWv9LpnQWeehogurjg=='
})
const FROZEN_RENDERER_PACKAGES = Object.freeze({
  'node_modules/mermaid': {
    version: '11.17.0',
    integrity: 'sha512-Jo9N377Wb4MSnHFPTbLi2SxFpsQl4eVHoxnW5U1Md9EazvgMp3s+4ohDxr81YNTgbn5Kj7HJ3yslrSJ52kwpbA=='
  },
  'node_modules/streamdown': {
    version: '2.5.0',
    integrity: 'sha512-/tTnURfIOxZK/pqJAxsfCvETG/XCJHoWnk3jq9xLcuz6CSpnjjuxSRBTTL4PKGhxiZQf0lqPxGhImdpwcZ2XwA=='
  }
})
const VULNERABLE_RESIDUE = Object.freeze([
  'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs',
  'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs.map',
  'node_modules/mermaid/dist/chunks/mermaid.esm.min/katex-CZ4GXH2S.mjs',
  'node_modules/mermaid/dist/chunks/mermaid.esm.min/katex-CZ4GXH2S.mjs.map'
])
const FILES = Object.freeze([
  'src/renderer/src/components/Markdown.security.browser.test.ts',
  'src/renderer/src/components/Markdown.katex.browser.test.ts',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
  'src/renderer/src/components/Markdown.warmup.test.ts',
  'src/renderer/src/components/CodeBlock.test.ts'
])
/** @type {ReadonlyArray<readonly [string, string, string]>} */
const greenCaseTriples = [
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M1 renders and records only allowed normalized links'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M2 refuses hostile Markdown and raw HTML URL forms without navigation'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M3 removes active raw HTML and remote images while preserving local images, links, and highlighted text'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M4 keeps inline code inline and gives empty, single-line, multiline, tilde, and backtick fences block controls'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M5 highlights curated aliases, falls back to full plain text, and copies the displayed code'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M6 converges streamed unfinished fences, discards stale highlight completion, and unmounts safely'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M7 renders a real responsive GFM table and the built-in copy menu exports cells'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M8 loads no Shiki grammar or WASM for prose and loads the real lazy graph once a fence arrives'
  ],
  [
    'src/renderer/src/components/Markdown.security.browser.test.ts',
    'production Markdown security and interaction browser regressions',
    'M9 preserves the baseline: math delimiters stay text and Mermaid fences stay copyable code'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K1 refuses inherited Object.prototype.trust and leaves no hostile href or external includegraphics URL'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K2 treats inherited trust on the options prototype as untrusted'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K3 does not let inherited default supply an omitted trust option'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K4 inherited processor cannot convert an own trust:false into trusted output'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K5 ignores inherited namespace macro entries instead of expanding the sentinel'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K6 does not create an own macro by restoring an inherited namespace value after group exit'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K7 renders actual math and local macros in both supported output modes'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K8 preserves the explicit safe HTTPS trust positive control and rejects restricted commands with trust:false'
  ],
  [
    'src/renderer/src/components/Markdown.katex.browser.test.ts',
    'actual installed KaTeX advisory and API regressions',
    'K9 bounds recursive macros, ignores inherited maxExpand, and renders valid math after errors'
  ],
  [
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
    'actual Mermaid core and production CSP browser regressions',
    'D1 imports Mermaid core and renders a real math flowchart through the exact shared KaTeX module'
  ],
  [
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
    'actual Mermaid core and production CSP browser regressions',
    'D2 keeps Mermaid legacy MathML labels styled by local KaTeX CSS and fonts'
  ],
  [
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
    'actual Mermaid core and production CSP browser regressions',
    'D3 keeps existing Mermaid sequence and class diagram relationships'
  ],
  [
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
    'actual Mermaid core and production CSP browser regressions',
    'D4 sanitizes hostile Mermaid URLs and directives under strict security with polluted inherited settings'
  ],
  [
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
    'actual Mermaid core and production CSP browser regressions',
    'D5 reports invalid diagrams cleanly and then renders distinct queued valid SVGs'
  ],
  [
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
    'actual Mermaid core and production CSP browser regressions',
    'C1 enforces the exact production CSP while ordinary renderer controls remain usable'
  ],
  [
    'src/renderer/src/components/Markdown.warmup.test.ts',
    'Markdown highlighter warm-up',
    'does not warm Shiki for ordinary streamed prose'
  ],
  [
    'src/renderer/src/components/Markdown.warmup.test.ts',
    'Markdown highlighter warm-up',
    'warms when a real backtick or tilde fence begins, including an unfinished streamed block'
  ],
  [
    'src/renderer/src/components/Markdown.warmup.test.ts',
    'Markdown highlighter warm-up',
    'warms once when a fence arrives after initial prose and never schedules it again'
  ],
  [
    'src/renderer/src/components/CodeBlock.test.ts',
    'isFencedBlock — fenced-vs-inline code signal',
    'treats a code element carrying data-block as a fenced block, regardless of its value'
  ],
  [
    'src/renderer/src/components/CodeBlock.test.ts',
    'isFencedBlock — fenced-vs-inline code signal',
    'treats a code element with no data-block key as genuinely inline'
  ],
  [
    'src/renderer/src/components/CodeBlock.test.ts',
    'isFencedBlock — fenced-vs-inline code signal',
    'is unaffected by language or newline content — those no longer decide block-vs-inline'
  ]
]
export const GREEN_CASES = Object.freeze(greenCaseTriples.map((entry) => Object.freeze(entry)))
const IDS = Object.freeze([
  ...Array.from({ length: 9 }, (_, index) => `M${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `K${index + 1}`),
  ...Array.from({ length: 5 }, (_, index) => `D${index + 1}`),
  'C1'
])
const CAUSAL_RED = Object.freeze(['K1', 'K2', 'K3', 'K4', 'K9'])
const EXPECTED_OLD_NAMESPACE_RED = Object.freeze(['K5', 'K6'])
const KATEX_TEST_PATH = 'src/renderer/src/components/Markdown.katex.browser.test.ts'
const KATEX_SUITE = 'actual installed KaTeX advisory and API regressions'
const CAUSAL_LOCATIONS = Object.freeze({
  K1: '86:7',
  K2: '105:110',
  K3: '145:110',
  K4: '161:103',
  K5: '192:20',
  K6: '231:20',
  K9: '349:30'
})
const CAUSAL_KEYS = Object.freeze({
  K5: Object.freeze(['errorMessage', 'errorName', 'rendered']),
  K6: Object.freeze(['after', 'own']),
  K9: Object.freeze(['errorMessage', 'errorName', 'rendered'])
})
const K5_SENTINEL =
  'StringMatching /(?:undefined control sequence|Undefined control sequence).*rendererInheritedSentinel/u'
const K6_SENTINEL =
  'StringMatching /^ParseError:.*(?:undefined control sequence|Undefined control sequence).*rendererScopedSentinel/u'

function fail(code) {
  throw new Error(`renderer-katex-provenance:${code}`)
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function parseArgs(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith('--') || !args[index + 1]) fail('ARGUMENTS')
    values.set(value.slice(2), args[++index])
  }
  if (
    !['baseline-red', 'remediation-green'].includes(values.get('mode')) ||
    !values.get('report') ||
    !values.get('log') ||
    !values.get('run-errors') ||
    !values.get('out') ||
    !values.has('test-exit')
  )
    fail('ARGUMENTS')
  if (
    values.get('mode') === 'remediation-green' &&
    (!values.get('audit') ||
      !values.get('sbom') ||
      !values.has('audit-exit') ||
      !values.has('sbom-exit') ||
      !values.get('audit-producer') ||
      !values.get('sbom-producer') ||
      !values.get('npm-ls') ||
      !values.has('npm-ls-exit') ||
      !values.get('npm-explain') ||
      !values.has('npm-explain-exit') ||
      !values.get('npm-explain-mermaid') ||
      !values.has('npm-explain-mermaid-exit') ||
      !values.get('evidence-report') ||
      !values.get('evidence-log') ||
      !values.get('evidence-errors') ||
      !values.get('evidence-attempt-report') ||
      !values.get('attempt-report') ||
      !values.get('build-graph') ||
      !values.has('evidence-exit'))
  )
    fail('ARGUMENTS')
  return values
}
function fileHash(root, path) {
  const bytes = readFileSync(resolve(root, path))
  return { bytes: bytes.byteLength, sha256: sha256(bytes) }
}
function gitText(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function gitBytes(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function changedPaths(root, range) {
  return gitText(root, ['diff', '--name-only', range]).split('\n').filter(Boolean).sort()
}
function requireExactPaths(actual, expected, code) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(code)
}
function requireAncestor(root, ancestor, head, code) {
  try {
    gitText(root, ['merge-base', '--is-ancestor', ancestor, head])
  } catch {
    fail(code)
  }
}
function checkSourceLineage(root) {
  const head = gitText(root, ['rev-parse', 'HEAD'])
  if (head !== (process.env.GITHUB_SHA || head)) fail('CHECKOUT_SHA_MISMATCH')
  if (gitText(root, ['rev-parse', `${IMAGE_POLICY_COMMIT}^`]) !== HARNESS_BASELINE) fail('IMAGE_POLICY_PARENT')
  requireAncestor(root, BASE, head, 'DEPENDENCY_BASELINE_ANCESTRY')
  requireAncestor(root, HARNESS_BASELINE, head, 'HARNESS_BASELINE_ANCESTRY')
  requireAncestor(root, IMAGE_POLICY_COMMIT, head, 'IMAGE_POLICY_ANCESTRY')
  requireExactPaths(
    changedPaths(root, `${BASE}..${HARNESS_BASELINE}`),
    HARNESS_BASELINE_FILES,
    'HARNESS_BASELINE_PATHS'
  )
  requireExactPaths(
    changedPaths(root, `${HARNESS_BASELINE}..${IMAGE_POLICY_COMMIT}`),
    [IMAGE_POLICY_PATH],
    'IMAGE_POLICY_PATHS'
  )
  requireExactPaths(changedPaths(root, `${IMAGE_POLICY_COMMIT}..${head}`), HARNESS_REPAIR_FILES, 'HARNESS_REPAIR_PATHS')
  requireExactPaths(
    changedPaths(root, `${BASE}..${head}`),
    [...HARNESS_BASELINE_FILES, IMAGE_POLICY_PATH],
    'COMPOSED_CHANGE_PATHS'
  )
  const reviewedBytes = gitBytes(root, ['show', `${IMAGE_POLICY_COMMIT}:${IMAGE_POLICY_PATH}`])
  const currentBytes = readFileSync(resolve(root, IMAGE_POLICY_PATH))
  const parentBytes = gitBytes(root, ['show', `${HARNESS_BASELINE}:${IMAGE_POLICY_PATH}`])
  if (
    sha256(reviewedBytes) !== IMAGE_POLICY_SHA256 ||
    sha256(currentBytes) !== IMAGE_POLICY_SHA256 ||
    sha256(parentBytes) !== 'b012099ba2a8d66cc29caee8555d5a92ff82b3c7b32c205273a90de2c5d67eaa'
  )
    fail('IMAGE_POLICY_BYTES')
  return {
    dependencyBaseline: BASE,
    originalHarnessBaseline: HARNESS_BASELINE,
    reviewedImagePolicyCommit: IMAGE_POLICY_COMMIT,
    imagePolicyParent: HARNESS_BASELINE,
    imagePolicyPath: IMAGE_POLICY_PATH,
    imagePolicySha256: IMAGE_POLICY_SHA256,
    harnessRepairFiles: [...HARNESS_REPAIR_FILES],
    composedPaths: changedPaths(root, `${BASE}..${head}`)
  }
}
function assertionId(assertion) {
  const name = assertion.title || assertion.fullName || ''
  return IDS.find((id) => name.startsWith(`${id} `) || name.startsWith(`${id}:`)) || null
}
function sourceRelative(fileName) {
  let localPath = fileName
  if (fileName.startsWith('file://')) localPath = new URL(fileName).pathname
  return relative(process.cwd(), resolve(localPath)).replaceAll('\\', '/')
}
function parseRawFailureSection(logText) {
  if (logText.includes('\0') || /\u001b/u.test(logText)) fail('RAW_LOG_UNEXPECTED_CONTROL')
  if (/\r(?!\n)/u.test(logText)) fail('RAW_LOG_LINE_ENDING')
  const lines = logText.replaceAll('\r\n', '\n').split('\n')
  const sections = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^⎯{3,} Failed Tests (\d+) ⎯{3,}$/u.exec(lines[index])
    if (match) sections.push({ index, declared: Number(match[1]) })
  }
  if (sections.length !== 1 || sections[0].declared !== 7) fail('RAW_FAILURE_SECTION_CARDINALITY')
  const section = lines.slice(sections[0].index + 1)
  const records = []
  let cursor = 0
  while (cursor < section.length) {
    if (!section[cursor].startsWith(' FAIL  ')) {
      if (/^⎯{3,}\[\d+\/\d+\]⎯$/u.test(section[cursor])) fail('RAW_FAILURE_DELIMITER_WITHOUT_BLOCK')
      cursor += 1
      continue
    }
    const header = section[cursor]
    const headerMatch = /^ FAIL  (.+\.ts) > (.+) > (K[1-9] .+)$/u.exec(header)
    if (!headerMatch) fail('RAW_FAILURE_HEADER')
    const start = cursor
    cursor += 1
    while (cursor < section.length && !/^⎯{3,}\[\d+\/\d+\]⎯$/u.test(section[cursor])) {
      if (section[cursor].startsWith(' FAIL  ')) fail('RAW_FAILURE_BLOCK_UNTERMINATED')
      cursor += 1
    }
    const delimiter = /^⎯{3,}\[(\d+)\/(\d+)\]⎯$/u.exec(section[cursor] || '')
    if (!delimiter) fail('RAW_FAILURE_BLOCK_TRUNCATED')
    const blockLines = [...section.slice(start, cursor), section[cursor]]
    if (Buffer.byteLength(blockLines.join('\n'), 'utf8') > 16_384) fail('RAW_FAILURE_BLOCK_SIZE')
    records.push({ header, path: headerMatch[1], suite: headerMatch[2], title: headerMatch[3], lines: blockLines })
    if (records.length > 7) fail('RAW_FAILURE_BLOCK_COUNT')
    if (Number(delimiter[1]) !== records.length || Number(delimiter[2]) !== 7) fail('RAW_FAILURE_DELIMITER_SEQUENCE')
    cursor += 1
  }
  const failLikeLines = section.filter((line) => /^\s*FAIL\b/u.test(line))
  if (records.length !== 7 || failLikeLines.length !== 7 || failLikeLines.some((line) => !line.startsWith(' FAIL  ')))
    fail('RAW_FAILURE_BLOCK_COUNT')
  const byId = new Map()
  for (const record of records) {
    const id = assertionId({ title: record.title })
    if (!CAUSAL_RED.includes(id) && !EXPECTED_OLD_NAMESPACE_RED.includes(id)) fail('RAW_UNEXPECTED_FAILURE')
    if (byId.has(id)) fail('RAW_FAILURE_DUPLICATE_CASE')
    byId.set(id, record)
  }
  if ([...CAUSAL_RED, ...EXPECTED_OLD_NAMESPACE_RED].some((id) => !byId.has(id))) fail('RAW_FAILURE_CASE_MISSING')
  return byId
}
function parseDiffMembers(lines, id) {
  const members = { expected: new Map(), received: new Map() }
  const common = []
  for (const line of lines) {
    if (!line) continue
    if (line === '  {' || line === '  }') {
      common.push(line)
      continue
    }
    const marker = line.slice(0, 2)
    if (marker !== '- ' && marker !== '+ ') fail('RAW_DIFF_GRAMMAR')
    if (!line.startsWith(`${marker}  `)) fail('RAW_DIFF_INDENTATION')
    const text = line.slice(4)
    const match = /^"([A-Za-z]+)": (.+?)(,?)$/u.exec(text)
    if (!match) fail('RAW_DIFF_MEMBER')
    const [, key, rawValue, comma] = match
    if (comma !== ',' || rawValue.endsWith(',')) fail('RAW_DIFF_COMMA')
    const target = marker === '- ' ? members.expected : members.received
    if (target.has(key)) fail('RAW_DIFF_DUPLICATE_MEMBER')
    let value
    if (rawValue === K5_SENTINEL && id === 'K5') value = '<<rendererInheritedSentinel undefined-control matcher>>'
    else if (rawValue === K6_SENTINEL && id === 'K6') value = '<<rendererScopedSentinel undefined-control matcher>>'
    else {
      try {
        value = JSON.parse(rawValue)
      } catch {
        fail('RAW_DIFF_VALUE')
      }
      if (value === null || !['string', 'boolean'].includes(typeof value)) fail('RAW_DIFF_VALUE_TYPE')
    }
    target.set(key, value)
  }
  if (JSON.stringify(common) !== JSON.stringify(['  {', '  }'])) fail('RAW_DIFF_OBJECT_CONTEXT')
  return members
}
function validateCausalBlock(id, record, assertion, relativeName) {
  if (Buffer.byteLength(record.lines.join('\n'), 'utf8') > 16_384) fail('RAW_FAILURE_BLOCK_SIZE')
  const expectedTitle = assertion.title
  if (
    record.path.replaceAll('\\', '/') !== KATEX_TEST_PATH ||
    record.suite !== KATEX_SUITE ||
    record.title !== expectedTitle ||
    relativeName !== KATEX_TEST_PATH ||
    assertion.fullName !== `${record.suite} ${record.title}` ||
    JSON.stringify(assertion.ancestorTitles) !== JSON.stringify([record.suite])
  )
    fail('RAW_JSON_IDENTITY_MISMATCH')
  const message = assertion.failureMessages[0]
  const firstLine = message.split('\n', 1)[0]
  const summaries = record.lines.filter((line) => line.startsWith('AssertionError: '))
  if (summaries.length !== 1 || summaries[0] !== firstLine || !firstLine.startsWith('AssertionError: '))
    fail('RAW_ASSERTION_SUMMARY_MISMATCH')
  if (/pageerror|unhandledrejection|browser.*closed|timeout|launch.*failed/iu.test(message))
    fail('RED_IS_HARNESS_FAILURE')
  const expectedLocation = CAUSAL_LOCATIONS[id]
  const rawFrames = record.lines.filter((line) => /^\s+❯ /u.test(line))
  if (rawFrames.length !== 1) fail('RAW_SOURCE_FRAME_CARDINALITY')
  const rawFrame = /^\s+❯ (.+):(\d+):(\d+)$/u.exec(rawFrames[0])
  if (
    !rawFrame ||
    rawFrame[1].replaceAll('\\', '/') !== KATEX_TEST_PATH ||
    `${rawFrame[2]}:${rawFrame[3]}` !== expectedLocation
  )
    fail('RAW_SOURCE_FRAME_MISMATCH')
  const jsonFrames = [...message.matchAll(/^\s+at (.+):(\d+):(\d+)$/gmu)]
  if (!jsonFrames.length) fail('JSON_SOURCE_FRAME_MISSING')
  const jsonFrame = jsonFrames[0]
  if (sourceRelative(jsonFrame[1]) !== KATEX_TEST_PATH || `${jsonFrame[2]}:${jsonFrame[3]}` !== expectedLocation)
    fail('JSON_SOURCE_FRAME_MISMATCH')
  const expectedHeading = record.lines.indexOf('- Expected')
  const receivedHeading = record.lines.indexOf('+ Received')
  const frameIndex = record.lines.indexOf(rawFrames[0])
  if (
    expectedHeading < 0 ||
    receivedHeading < 0 ||
    record.lines.lastIndexOf('- Expected') !== expectedHeading ||
    record.lines.lastIndexOf('+ Received') !== receivedHeading ||
    expectedHeading >= receivedHeading ||
    receivedHeading >= frameIndex
  )
    fail('RAW_DIFF_HEADINGS')
  const diff = record.lines.slice(receivedHeading + 1, frameIndex)
  let received
  if (['K1', 'K2', 'K3', 'K4'].includes(id)) {
    const meaningful = diff.filter(Boolean)
    if (JSON.stringify(meaningful) !== JSON.stringify(['- []', '+ [', `+   "javascript:alert(1)",`, '+ ]']))
      fail('RAW_UNSAFE_HREF_CAUSE_MISSING')
    received = ['javascript:alert(1)']
  } else {
    const { expected, received: actual } = parseDiffMembers(record.lines.slice(receivedHeading + 1, frameIndex), id)
    const expectedKeys = CAUSAL_KEYS[id]
    if (
      JSON.stringify([...expected.keys()]) !== JSON.stringify(expectedKeys) ||
      JSON.stringify([...actual.keys()]) !== JSON.stringify(expectedKeys)
    )
      fail('RAW_DIFF_MEMBER_SET')
    const actualValue = Object.fromEntries(actual)
    const expectedValue = Object.fromEntries(expected)
    if (id === 'K5') {
      if (JSON.stringify(actualValue) !== JSON.stringify({ errorMessage: '', errorName: '', rendered: true }))
        fail('RED_INHERITED_MACRO_CAUSE_MISSING')
      if (
        JSON.stringify(expectedValue) !==
        JSON.stringify({
          errorMessage: '<<rendererInheritedSentinel undefined-control matcher>>',
          errorName: 'ParseError',
          rendered: false
        })
      )
        fail('RAW_INHERITED_MACRO_EXPECTATION')
    } else if (id === 'K6') {
      if (JSON.stringify(actualValue) !== JSON.stringify({ after: 'rendered', own: true }))
        fail('RED_INHERITED_UNDO_CAUSE_MISSING')
      if (
        JSON.stringify(expectedValue) !==
        JSON.stringify({
          after: '<<rendererScopedSentinel undefined-control matcher>>',
          own: false
        })
      )
        fail('RAW_INHERITED_UNDO_EXPECTATION')
    } else if (id === 'K9') {
      if (
        JSON.stringify(actualValue) !==
        JSON.stringify({
          errorMessage: 'KaTeX parse error: Too many expansions: infinite loop or need to increase maxExpand setting',
          errorName: 'ParseError',
          rendered: false
        })
      )
        fail('RED_INHERITED_BOUND_CAUSE_MISSING')
      if (JSON.stringify(expectedValue) !== JSON.stringify({ errorMessage: '', errorName: '', rendered: true }))
        fail('RAW_INHERITED_BOUND_EXPECTATION')
    }
    received = actualValue
  }
  return {
    rawBlockSha256: sha256(Buffer.from(record.lines.join('\n'), 'utf8')),
    sourceLocation: expectedLocation,
    received
  }
}
function causalFixture(id, diffLines, location, summary) {
  const title = `${id} fixture title bound to its assertion`
  const source = `${resolve(process.cwd(), KATEX_TEST_PATH)}:${location}`
  const assertion = {
    title,
    fullName: `${KATEX_SUITE} ${title}`,
    ancestorTitles: [KATEX_SUITE],
    failureMessages: [`${summary}\n    at ${source}\n    at file:///fixture/runner.js:1:1`]
  }
  const lines = [
    ` FAIL  ${KATEX_TEST_PATH} > ${KATEX_SUITE} > ${title}`,
    summary,
    '',
    '- Expected',
    '+ Received',
    ...diffLines,
    '',
    ` ❯ ${KATEX_TEST_PATH}:${location}`
  ]
  return { assertion, record: { path: KATEX_TEST_PATH, suite: KATEX_SUITE, title, lines } }
}
function requireFixtureReject(id, fixture) {
  let rejected = false
  try {
    validateCausalBlock(id, fixture.record, fixture.assertion, KATEX_TEST_PATH)
  } catch {
    rejected = true
  }
  if (!rejected) fail('CAUSAL_FIXTURE_ACCEPTED_INVALID')
}
function requireRawSectionReject(text) {
  let rejected = false
  try {
    parseRawFailureSection(text)
  } catch {
    rejected = true
  }
  if (!rejected) fail('RAW_SECTION_FIXTURE_ACCEPTED_INVALID')
}
function duplicateFixtureLine(fixture, prefix) {
  const lines = [...fixture.record.lines]
  const index = lines.findIndex((line) => line.startsWith(prefix))
  if (index < 0) fail('CAUSAL_FIXTURE_SOURCE_LINE_MISSING')
  lines.splice(index, 0, lines[index])
  return { ...fixture, record: { ...fixture.record, lines } }
}
function checkCausalParserFixtures() {
  const cases = [
    {
      id: 'K1',
      location: CAUSAL_LOCATIONS.K1,
      summary: "AssertionError: expected [ 'javascript:alert(1)' ] to deeply equal []",
      diff: ['', '- []', '+ [', `+   "javascript:alert(1)",`, '+ ]']
    },
    ...['K2', 'K3', 'K4'].map((id) => ({
      id,
      location: CAUSAL_LOCATIONS[id],
      summary: "AssertionError: expected [ 'javascript:alert(1)' ] to deeply equal []",
      diff: ['', '- []', '+ [', `+   "javascript:alert(1)",`, '+ ]']
    })),
    {
      id: 'K5',
      location: CAUSAL_LOCATIONS.K5,
      summary:
        "AssertionError: expected { rendered: true, errorName: '', …(1) } to deeply equal { rendered: false, …(2) }",
      diff: [
        '  {',
        `-   "errorMessage": ${K5_SENTINEL},`,
        '-   "errorName": "ParseError",',
        '-   "rendered": false,',
        '+   "errorMessage": "",',
        '+   "errorName": "",',
        '+   "rendered": true,',
        '  }'
      ]
    },
    {
      id: 'K6',
      location: CAUSAL_LOCATIONS.K6,
      summary: "AssertionError: expected { own: true, after: 'rendered' } to deeply equal { Object (own, after) }",
      diff: [
        '  {',
        `-   "after": ${K6_SENTINEL},`,
        '-   "own": false,',
        '+   "after": "rendered",',
        '+   "own": true,',
        '  }'
      ]
    },
    {
      id: 'K9',
      location: CAUSAL_LOCATIONS.K9,
      summary:
        "AssertionError: expected { rendered: false, …(2) } to deeply equal { rendered: true, errorName: '', …(1) }",
      diff: [
        '  {',
        '-   "errorMessage": "",',
        '-   "errorName": "",',
        '-   "rendered": true,',
        '+   "errorMessage": "KaTeX parse error: Too many expansions: infinite loop or need to increase maxExpand setting",',
        '+   "errorName": "ParseError",',
        '+   "rendered": false,',
        '  }'
      ]
    }
  ].map((fixture) => ({ ...fixture, ...causalFixture(fixture.id, fixture.diff, fixture.location, fixture.summary) }))
  for (const fixture of cases) validateCausalBlock(fixture.id, fixture.record, fixture.assertion, KATEX_TEST_PATH)
  const k1 = cases.find(({ id }) => id === 'K1')
  const k5 = cases.find(({ id }) => id === 'K5')
  const k6 = cases.find(({ id }) => id === 'K6')
  const k9 = cases.find(({ id }) => id === 'K9')
  const ids = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K9']
  const rawLines = ids.flatMap((id, index) => [
    ` FAIL  ${KATEX_TEST_PATH} > ${KATEX_SUITE} > ${id} synthetic section fixture`,
    'AssertionError: synthetic fixture summary',
    `⎯⎯⎯[${index + 1}/7]⎯`
  ])
  const rawSection = `⎯⎯⎯ Failed Tests 7 ⎯⎯⎯\n${rawLines.join('\n')}`
  if (parseRawFailureSection(rawSection).size !== 7) fail('RAW_SECTION_FIXTURE_REJECTED_VALID')
  requireRawSectionReject(rawSection.replace('K9 synthetic section fixture', 'K1 synthetic section fixture'))
  requireRawSectionReject(rawSection.replace('Failed Tests 7', 'Failed Tests 8'))
  requireRawSectionReject(rawSection.replace(']⎯', ']⎯⎯'))
  requireRawSectionReject(rawSection.replace(' FAIL  ', ' FAIL '))
  requireRawSectionReject(rawSection.slice(0, rawSection.lastIndexOf('⎯')))
  requireFixtureReject('K1', duplicateFixtureLine(k1, '+   "javascript:alert(1)",'))
  const expectedOnlyUnsafeLines = k1.record.lines
    .filter((line) => !['+ [', '+   "javascript:alert(1)",', '+ ]'].includes(line))
    .map((line) => (line === '- []' ? '- ["javascript:alert(1)"]' : line))
  expectedOnlyUnsafeLines.splice(expectedOnlyUnsafeLines.indexOf('+ Received') + 1, 0, '+ []')
  requireFixtureReject('K1', {
    ...k1,
    record: { ...k1.record, lines: expectedOnlyUnsafeLines }
  })
  requireFixtureReject('K5', {
    ...k5,
    record: {
      ...k5.record,
      lines: k5.record.lines.map((line) => (line === '+   "rendered": true,' ? '+   "rendered": false,' : line))
    }
  })
  requireFixtureReject('K6', {
    ...k6,
    record: {
      ...k6.record,
      lines: k6.record.lines.map((line) => (line === '+   "own": true,' ? '+   "own": false,' : line))
    }
  })
  requireFixtureReject('K9', {
    ...k9,
    record: {
      ...k9.record,
      lines: k9.record.lines.map((line) =>
        line.includes('Too many expansions') ? '+   "errorMessage": "Too many expansions",' : line
      )
    }
  })
  requireFixtureReject('K5', duplicateFixtureLine(k5, '+   "rendered": true,'))
  requireFixtureReject('K1', {
    ...k1,
    record: {
      ...k1.record,
      lines: k1.record.lines.map((line) =>
        line === ` ❯ ${KATEX_TEST_PATH}:${CAUSAL_LOCATIONS.K1}` ? ` ❯ ${KATEX_TEST_PATH}:${CAUSAL_LOCATIONS.K2}` : line
      )
    }
  })
  requireFixtureReject('K1', {
    ...k1,
    record: {
      ...k1.record,
      lines: k1.record.lines.map((line) =>
        line.startsWith('AssertionError: ') ? line.replace('AssertionError: ', 'TypeError: ') : line
      )
    },
    assertion: {
      ...k1.assertion,
      failureMessages: k1.assertion.failureMessages.map((message) => message.replace('AssertionError: ', 'TypeError: '))
    }
  })
  requireFixtureReject('K1', { ...k1, record: { ...k1.record, title: 'K9 wrong-case graft' } })
}
function checkReport(reportPath, exitCode, rawBlocks) {
  let report
  if (statSync(reportPath).size > 16 * 1024 * 1024) fail('VITEST_REPORT_SIZE')
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    fail('VITEST_REPORT_INVALID')
  }
  const results = Array.isArray(report.testResults) ? report.testResults : fail('SUITE_INVENTORY_MISSING')
  const fileNames = results.map((file) => relative(process.cwd(), resolve(file.name)).replaceAll('\\', '/')).sort()
  if (JSON.stringify(fileNames) !== JSON.stringify([...FILES].sort())) fail('SUITE_INVENTORY')
  if (
    !Number.isInteger(report.numTotalTestSuites) ||
    !Number.isInteger(report.numPassedTestSuites) ||
    !Number.isInteger(report.numFailedTestSuites) ||
    !Number.isInteger(report.numPendingTestSuites)
  )
    fail('SUITE_SUMMARY_SCHEMA')
  const suiteStates = new Map()
  function recordSuitePrefix(prefix, failed) {
    const key = JSON.stringify(prefix)
    suiteStates.set(key, suiteStates.get(key) || false || failed)
  }
  for (const file of results) {
    if (!['passed', 'failed'].includes(file.status) || typeof file.message !== 'string') fail('SUITE_RESULT_SCHEMA')
    // Vitest 4's JSON reporter puts hook/runtime suite errors in testResults[].message;
    // assertion-only failures stay in assertionResults and leave that message empty.
    if (file.message.length !== 0) fail('INDEPENDENT_SUITE_OR_HOOK_ERROR')
    const fileAssertions = Array.isArray(file.assertionResults) ? file.assertionResults : []
    const hasFailedAssertion = fileAssertions.some((entry) => entry.status === 'failed')
    if ((file.status === 'failed') !== hasFailedAssertion) fail('SUITE_STATUS_ASSERTION_MISMATCH')
    const relativeName = relative(process.cwd(), resolve(file.name)).replaceAll('\\', '/')
    recordSuitePrefix([relativeName], hasFailedAssertion)
    for (const assertion of fileAssertions) {
      const ancestors = assertion.ancestorTitles
      if (
        !Array.isArray(ancestors) ||
        ancestors.length === 0 ||
        ancestors.some((title) => typeof title !== 'string' || !title)
      )
        fail('SUITE_ANCESTOR_INVENTORY')
      for (let index = 1; index <= ancestors.length; index += 1)
        recordSuitePrefix([relativeName, ...ancestors.slice(0, index)], assertion.status === 'failed')
    }
  }
  const failedSuiteCount = [...suiteStates.values()].filter(Boolean).length
  if (
    report.numTotalTestSuites !== suiteStates.size ||
    report.numFailedTestSuites !== failedSuiteCount ||
    report.numPassedTestSuites !== suiteStates.size - failedSuiteCount ||
    report.numPendingTestSuites !== 0
  )
    fail('SUITE_SUMMARY_MISMATCH')
  const assertions = results.flatMap((file) => (Array.isArray(file.assertionResults) ? file.assertionResults : []))
  if (assertions.length !== 30 || report.numTotalTests !== 30) fail('TOTAL_TEST_COUNT')
  if (
    (report.numPendingTests ?? 0) !== 0 ||
    (report.numTodoTests ?? 0) !== 0 ||
    (report.numSkippedTests ?? 0) !== 0 ||
    (report.numCancelledTests ?? 0) !== 0
  )
    fail('SKIPPED_TODO_OR_PENDING')
  if (
    assertions.some(
      (entry) => !['passed', 'failed'].includes(entry.status) || entry.retryReason || Number(entry.retryCount || 0) > 0
    )
  )
    fail('STATUS_OR_RETRY')
  const identified = assertions.map(assertionId).filter(Boolean)
  if (
    identified.length !== IDS.length ||
    new Set(identified).size !== IDS.length ||
    IDS.some((id) => !identified.includes(id))
  )
    fail('CASE_ROSTER')
  const failed = assertions.filter((entry) => entry.status === 'failed')
  const failedIds = failed.map(assertionId).sort()
  if (JSON.stringify(failedIds) !== JSON.stringify([...CAUSAL_RED, ...EXPECTED_OLD_NAMESPACE_RED].sort()))
    fail('UNEXPECTED_FAILURE_SET')
  for (const entry of failed)
    if (
      !Array.isArray(entry.failureMessages) ||
      entry.failureMessages.length !== 1 ||
      typeof entry.failureMessages[0] !== 'string' ||
      entry.failureMessages[0].length > 16_384 ||
      !entry.failureMessages[0].startsWith('AssertionError: ')
    )
      fail('RED_ASSERTION_MESSAGE_CARDINALITY')
  if (
    exitCode !== 1 ||
    report.success !== false ||
    report.numFailedTests !== failedIds.length ||
    report.numPassedTests !== 30 - failedIds.length
  )
    fail('NOT_ACTUAL_NONZERO_RED')
  const causalEvidence = new Map()
  for (const failure of failed) {
    const id = assertionId(failure)
    const owner = results.find((file) => file.assertionResults?.includes(failure))
    if (!owner) fail('RED_ASSERTION_OWNER_MISSING')
    const relativeName = relative(process.cwd(), resolve(owner.name)).replaceAll('\\', '/')
    const record = rawBlocks.get(id)
    if (!record) fail('RAW_FAILURE_CASE_MISSING')
    causalEvidence.set(id, validateCausalBlock(id, record, failure, relativeName))
  }
  return {
    selectedFiles: fileNames,
    total: assertions.length,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests ?? 0,
    todo: report.numTodoTests ?? 0,
    retries: 0,
    failedCases: failed
      .map((entry) => {
        const id = assertionId(entry)
        const evidence = causalEvidence.get(id)
        return {
          id,
          title: entry.fullName || entry.title,
          failureSha256: sha256(Buffer.from(entry.failureMessages[0], 'utf8')),
          rawBlockSha256: evidence.rawBlockSha256,
          sourceLocation: evidence.sourceLocation,
          received: evidence.received,
          causalFailureExcerpt: rawBlocks.get(id).lines.join('\n').slice(0, 2_000),
          observedUnsafeOutput: ['K1', 'K2', 'K3', 'K4'].includes(id) ? evidence.received[0] : undefined
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    assertionCases: assertions
      .map((entry) => ({ id: assertionId(entry), status: entry.status }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }
}
/** @param {string} expectedKaTeXVersion */
export function checkHarnessOrigins(directory, expectedKaTeXVersion = OLD_KATEX.version) {
  const names = readdirSync(directory)
    .filter((name) => /^harness-origin-[0-9a-f-]{36}\.json$/u.test(name))
    .sort()
  if (names.length !== 3) fail('HARNESS_ORIGIN_COUNT')
  const origins = names.map((name) => {
    const path = resolve(directory, name)
    const stat = statSync(path)
    if (stat.size > 65_536) fail('HARNESS_ORIGIN_SIZE')
    let value
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      fail('HARNESS_ORIGIN_JSON')
    }
    if (
      value.katexVersion !== expectedKaTeXVersion ||
      !/^\d+\.\d+\.\d+\.\d+(?:-.*)?$/u.test(value.browserVersion || '')
    )
      fail('HARNESS_RUNTIME_IDENTITY')
    const directEdge = value.directEdge
    const mermaidEdge = value.mermaidEdge
    const normalize = (text) => String(text || '').replaceAll('\\', '/')
    const validCandidate = (candidate) =>
      candidate &&
      typeof candidate.importer === 'string' &&
      typeof candidate.target === 'string' &&
      ['static', 'dynamic'].includes(candidate.kind) &&
      ['asset', 'runtime', 'other'].includes(candidate.assetKind) &&
      (candidate.chunk === null || typeof candidate.chunk === 'string') &&
      Number.isSafeInteger(candidate.renderedLength) &&
      candidate.renderedLength >= 0 &&
      Array.isArray(candidate.renderedExports) &&
      candidate.renderedExports.every((name) => typeof name === 'string')
    if (
      value.directImporterPresent !== true ||
      !Array.isArray(value.directCandidates) ||
      value.directCandidates.length === 0 ||
      value.directCandidates.length > 64 ||
      !value.directCandidates.every(
        (candidate) => validCandidate(candidate) && candidate.importer === '\0renderer-katex-security-harness'
      ) ||
      !Array.isArray(value.mermaidCandidates) ||
      value.mermaidCandidates.length === 0 ||
      value.mermaidCandidates.length > 128 ||
      !value.mermaidCandidates.every(
        (candidate) =>
          validCandidate(candidate) &&
          /\/node_modules\/mermaid\/dist\/chunks\/mermaid\.core\//u.test(normalize(candidate.importer))
      )
    )
      fail('HARNESS_CANDIDATE_INVENTORY')
    const directRuntimeCandidates = value.directCandidates.filter(
      (candidate) =>
        candidate.assetKind === 'runtime' &&
        typeof candidate.chunk === 'string' &&
        candidate.chunk &&
        candidate.renderedLength > 0
    )
    const mermaidRuntimeCandidates = value.mermaidCandidates.filter(
      (candidate) =>
        candidate.assetKind === 'runtime' &&
        typeof candidate.chunk === 'string' &&
        candidate.chunk &&
        candidate.renderedLength > 0
    )
    if (
      directRuntimeCandidates.length !== 1 ||
      mermaidRuntimeCandidates.length !== 1 ||
      !value.directCandidates.some(
        (candidate) => candidate.assetKind === 'asset' && /katex\.min\.css(?:$|[?#])/iu.test(candidate.target)
      )
    )
      fail('HARNESS_RUNTIME_EDGE_CARDINALITY')
    const selectedDirect = directRuntimeCandidates[0]
    const selectedMermaid = mermaidRuntimeCandidates[0]
    if (
      !directEdge ||
      directEdge.importer !== '\0renderer-katex-security-harness' ||
      !directEdge.target ||
      !directEdge.chunk ||
      !mermaidEdge ||
      !mermaidEdge.importer ||
      !mermaidEdge.target ||
      !mermaidEdge.chunk ||
      JSON.stringify(directEdge) !== JSON.stringify(selectedDirect) ||
      JSON.stringify(mermaidEdge) !== JSON.stringify(selectedMermaid) ||
      directEdge.target !== mermaidEdge.target ||
      directEdge.chunk !== mermaidEdge.chunk ||
      !directEdge.renderedExports.includes('renderToString') ||
      !directEdge.renderedExports.includes('version') ||
      !mermaidEdge.renderedExports.includes('renderToString') ||
      !mermaidEdge.renderedExports.includes('version') ||
      value.katexDirect !== directEdge.target ||
      value.katexFromMermaid !== mermaidEdge.target ||
      !/(?:^|\/)node_modules\/katex\//u.test(normalize(directEdge.target)) ||
      !/\/node_modules\/mermaid\/dist\/chunks\/mermaid\.core\//u.test(normalize(mermaidEdge.importer))
    )
      fail('HARNESS_KATEX_MODULE_IDENTITY')
    if (!/node_modules[\\/]mermaid[\\/]dist[\\/]mermaid\.core\.mjs$/u.test(value.mermaidCore || ''))
      fail('HARNESS_MERMAID_CORE_IDENTITY')
    if (
      !Array.isArray(value.shikiChunks) ||
      value.shikiChunks.length === 0 ||
      value.shikiChunks.some((chunk) => typeof chunk !== 'string' || !chunk)
    )
      fail('HARNESS_SHIKI_CHUNK_MAP')
    return {
      name,
      sha256: sha256(readFileSync(path)),
      katexVersion: value.katexVersion,
      browserVersion: value.browserVersion,
      katexDirect: value.katexDirect,
      katexFromMermaid: value.katexFromMermaid,
      mermaidCore: value.mermaidCore,
      directImporterPresent: value.directImporterPresent,
      directCandidates: value.directCandidates,
      mermaidCandidates: value.mermaidCandidates,
      directEdge,
      mermaidEdge,
      shikiChunks: value.shikiChunks
    }
  })
  const first = JSON.stringify({ ...origins[0], name: undefined, sha256: undefined })
  if (origins.some((origin) => JSON.stringify({ ...origin, name: undefined, sha256: undefined }) !== first))
    fail('HARNESS_ORIGIN_DIVERGENCE')
  return origins
}
export function checkRunErrors(reportPath, expectedPath, expectedFileCount = FILES.length) {
  if (reportPath !== expectedPath) fail('RUN_ERRORS_PATH')
  const stat = statSync(reportPath)
  if (stat.size > 32 * 1024) fail('RUN_ERRORS_SIZE')
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    fail('RUN_ERRORS_INVALID')
  }
  if (
    report.schema !== 1 ||
    report.runId !== (process.env.GITHUB_RUN_ID || null) ||
    report.runAttempt !== (process.env.GITHUB_RUN_ATTEMPT || null) ||
    report.job !== (process.env.GITHUB_JOB || null) ||
    report.runnerOs !== (process.env.RUNNER_OS || process.platform) ||
    report.fileCount !== expectedFileCount ||
    !Number.isInteger(report.errorCount) ||
    report.errorCount !== 0 ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    report.omittedErrors !== 0
  )
    fail('UNHANDLED_ERRORS_PRESENT_OR_RUN_MISMATCH')
  return { bytes: stat.size, sha256: sha256(readFileSync(reportPath)), errorCount: report.errorCount, errorCodes: [] }
}
function checkRawGreenLog(logBytes, code) {
  const logText = logBytes.toString('utf8')
  if (
    !Buffer.from(logText, 'utf8').equals(logBytes) ||
    logText.includes('\0') ||
    /\r(?!\n)/u.test(logText) ||
    /^(?:\s*FAIL(?:\s|$)|\s*Failed Tests\b|\s*Unhandled Error\b|\s*Error(?::|\s*\[)|\s*AssertionError:)/mu.test(logText)
  )
    fail(code)
  return { bytes: logBytes.length, sha256: sha256(logBytes) }
}

export class RendererAttemptReporter {
  constructor() {
    this.testCases = []
  }

  onTestCaseResult(testCase) {
    const diagnostic = testCase.diagnostic()
    if (!diagnostic) fail('ATTEMPT_REPORTER_DIAGNOSTIC_MISSING')
    const ancestorTitles = []
    let parent = testCase.parent
    while (parent && parent.type !== 'module') {
      ancestorTitles.unshift(parent.name)
      parent = parent.parent
    }
    this.testCases.push({
      file: testCase.module.moduleId,
      ancestorTitles,
      title: testCase.name,
      state: testCase.result().state,
      retryCount: diagnostic.retryCount,
      repeatCount: diagnostic.repeatCount,
      flaky: diagnostic.flaky,
      retryOption: testCase.options.retry ?? 0,
      repeatOption: testCase.options.repeats ?? 0
    })
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const reportPath = process.env.RENDERER_ATTEMPT_REPORT
    const reportRoot = resolve(process.env.REPORT_DIR || dirname(reportPath || '.'))
    if (
      !reportPath ||
      !relative(reportRoot, resolve(reportPath)) ||
      relative(reportRoot, resolve(reportPath)).startsWith('..') ||
      isAbsolute(relative(reportRoot, resolve(reportPath)))
    )
      fail('ATTEMPT_REPORT_PATH')
    const moduleResults = testModules.map((module) => ({
      file: module.moduleId,
      state: module.state(),
      errors: module.errors().length,
      diagnosticAvailable: module.diagnostic() !== undefined
    }))
    const report = {
      schema: 1,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runnerOs: process.env.RUNNER_OS || process.platform,
      sourceCommit: process.env.GITHUB_SHA || null,
      reason: String(reason),
      unhandledErrorCount: unhandledErrors.length,
      moduleResults,
      testCases: this.testCases
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  }
}

export default RendererAttemptReporter

function checkAttemptReport(reportPath, { expectedPath, expectedCases, expectedFileCount }) {
  if (resolve(reportPath) !== resolve(expectedPath)) fail('ATTEMPT_REPORT_PATH')
  const bytes = readFileSync(reportPath)
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) fail('ATTEMPT_REPORT_SIZE')
  let report
  try {
    report = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('ATTEMPT_REPORT_JSON')
  }
  if (
    report.schema !== 1 ||
    report.runId !== (process.env.GITHUB_RUN_ID || null) ||
    report.runAttempt !== (process.env.GITHUB_RUN_ATTEMPT || null) ||
    report.job !== (process.env.GITHUB_JOB || null) ||
    report.runnerOs !== (process.env.RUNNER_OS || process.platform) ||
    report.sourceCommit !== (process.env.GITHUB_SHA || null) ||
    report.reason !== 'passed' ||
    report.unhandledErrorCount !== 0 ||
    !Array.isArray(report.moduleResults) ||
    report.moduleResults.length !== expectedFileCount ||
    report.moduleResults.some(
      (module) => module.state !== 'passed' || module.errors !== 0 || module.diagnosticAvailable !== true
    ) ||
    !Array.isArray(report.testCases) ||
    report.testCases.length !== expectedCases.length
  )
    fail('ATTEMPT_REPORT_IDENTITY_OR_STATUS')
  const actual = []
  for (const test of report.testCases) {
    if (
      test.state !== 'passed' ||
      test.retryCount !== 0 ||
      test.repeatCount !== 0 ||
      test.flaky !== false ||
      test.retryOption !== 0 ||
      test.repeatOption !== 0 ||
      !Array.isArray(test.ancestorTitles) ||
      typeof test.title !== 'string'
    )
      fail('ATTEMPT_RETRY_REPEAT_OR_TEST_STATE')
    const file = relative(process.cwd(), resolve(test.file)).replaceAll('\\', '/')
    actual.push(JSON.stringify([file, test.ancestorTitles, test.title]))
  }
  actual.sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expectedCases].map((entry) => JSON.stringify(entry)).sort()))
    fail('ATTEMPT_CASE_ROSTER')
  const expectedFiles = [...new Set(expectedCases.map(([file]) => file))].sort()
  const actualModuleFiles = report.moduleResults
    .map((module) => relative(process.cwd(), resolve(module.file)).replaceAll('\\', '/'))
    .sort()
  if (JSON.stringify(actualModuleFiles) !== JSON.stringify(expectedFiles)) fail('ATTEMPT_MODULE_FILE_ROSTER')
  return { bytes: bytes.length, sha256: sha256(bytes), caseCount: actual.length, retryCount: 0, repeatCount: 0 }
}

export function checkEvidenceSuite(reportPath, logPath, exitCode, errorsPath, expectedErrorsPath, attemptPath) {
  if (exitCode !== 0 || errorsPath !== expectedErrorsPath || !attemptPath) fail('EVIDENCE_SUITE_EXIT_OR_ERRORS_PATH')
  const reportBytes = readFileSync(reportPath)
  const logBytes = readFileSync(logPath)
  if (reportBytes.length > 8 * 1024 * 1024 || logBytes.length > 2 * 1024 * 1024) fail('EVIDENCE_SUITE_SIZE')
  let report
  try {
    report = JSON.parse(reportBytes.toString('utf8'))
  } catch {
    fail('EVIDENCE_SUITE_JSON')
  }
  const files = report.testResults
  if (
    !Array.isArray(files) ||
    files.length !== 1 ||
    relative(process.cwd(), resolve(files[0].name)).replaceAll('\\', '/') !== EVIDENCE_TEST_PATH
  )
    fail('EVIDENCE_SUITE_FILE_INVENTORY')
  const assertions = files[0].assertionResults
  if (!Array.isArray(assertions) || assertions.length !== EVIDENCE_TEST_COUNT) fail('EVIDENCE_SUITE_CASE_COUNT')
  if (
    files[0].status !== 'passed' ||
    files[0].message !== '' ||
    assertions.some((entry) => entry.status !== 'passed' || entry.failureMessages?.length !== 0) ||
    report.success !== true ||
    report.numTotalTests !== EVIDENCE_TEST_COUNT ||
    report.numPassedTests !== EVIDENCE_TEST_COUNT ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numTotalTestSuites !== 2 ||
    report.numPassedTestSuites !== 2 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0
  )
    fail('EVIDENCE_SUITE_NOT_GREEN')
  const expectedRoster = EVIDENCE_CASES.map((title) =>
    JSON.stringify([EVIDENCE_TEST_PATH, ['renderer remediation evidence validators'], title])
  ).sort()
  const actualCases = assertions
    .map((entry) => JSON.stringify([EVIDENCE_TEST_PATH, entry.ancestorTitles, entry.title]))
    .sort()
  if (
    JSON.stringify(actualCases) !== JSON.stringify(expectedRoster) ||
    assertions.some((entry) => entry.fullName !== `renderer remediation evidence validators ${entry.title}`)
  )
    fail('EVIDENCE_SUITE_CASE_ROSTER')
  const log = checkRawGreenLog(logBytes, 'EVIDENCE_SUITE_LOG_FAILURE')
  const unhandledErrors = checkRunErrors(errorsPath, expectedErrorsPath, 1)
  const expectedCases = EVIDENCE_CASES.map((title) => [
    EVIDENCE_TEST_PATH,
    ['renderer remediation evidence validators'],
    title
  ])
  const attempt = checkAttemptReport(attemptPath, {
    expectedPath: resolve(dirname(reportPath), 'evidence-attempt.json'),
    expectedCases,
    expectedFileCount: 1
  })
  return {
    file: EVIDENCE_TEST_PATH,
    caseCount: EVIDENCE_TEST_COUNT,
    report: { bytes: reportBytes.length, sha256: sha256(reportBytes) },
    log,
    unhandledErrors,
    attempt
  }
}
export function validateRemediationLineageFacts(facts) {
  if (
    facts.repository !== APPROVED_REPOSITORY ||
    facts.ref !== `refs/heads/${REMEDIATION_BRANCH}` ||
    !/^[a-f0-9]{40}$/u.test(facts.head || '') ||
    facts.head !== facts.githubSha ||
    facts.dependencyParent !== DEPENDENCY_BASELINE ||
    facts.imagePolicyParent !== HARNESS_BASELINE ||
    facts.dirty !== false
  )
    fail('GREEN_SOURCE_IDENTITY')
  for (const commit of [BASE, HARNESS_BASELINE, IMAGE_POLICY_COMMIT, DEPENDENCY_BASELINE, DEPENDENCY_COMMIT])
    if (facts.ancestors?.[commit] !== true) fail(`GREEN_HISTORICAL_ANCESTRY:${commit}`)
  if (facts.ancestors?.[facts.head] !== true || facts.ancestors?.[DEPENDENCY_COMMIT] !== true)
    fail('GREEN_DEPENDENCY_ANCESTRY')
  const pathPredicates = [
    ['baseToHarness', HARNESS_BASELINE_FILES, 'GREEN_HARNESS_BASELINE_PATHS'],
    ['harnessToPolicy', [IMAGE_POLICY_PATH], 'GREEN_IMAGE_POLICY_PATHS'],
    ['policyToR', HARNESS_REPAIR_FILES, 'GREEN_HISTORICAL_REPAIR_PATHS'],
    ['baseToR', [...new Set([...HARNESS_BASELINE_FILES, IMAGE_POLICY_PATH])], 'GREEN_HISTORICAL_COMPOSED_PATHS'],
    ['rToD', ['package.json', 'package-lock.json'], 'GREEN_R_TO_D_PATHS'],
    ['dToG', REMEDIATION_FILES, 'GREEN_D_TO_G_PATHS'],
    ['rToG', ['package.json', 'package-lock.json', ...REMEDIATION_FILES], 'GREEN_R_TO_G_PATHS']
  ]
  for (const [key, expected, code] of pathPredicates) {
    const actual = facts.paths?.[key]
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(code)
  }
  if (
    facts.historicalPackageHashes?.manifest !== BASE_HASHES['package.json'] ||
    facts.historicalPackageHashes?.lock !== BASE_HASHES['package-lock.json'] ||
    facts.policyHashes?.parent !== 'b012099ba2a8d66cc29caee8555d5a92ff82b3c7b32c205273a90de2c5d67eaa' ||
    facts.policyHashes?.reviewed !== IMAGE_POLICY_SHA256 ||
    facts.policyHashes?.atR !== IMAGE_POLICY_SHA256
  )
    fail('GREEN_HISTORICAL_BYTES')
  return {
    head: facts.head,
    dependencyBaseline: DEPENDENCY_BASELINE,
    dependencyCommit: DEPENDENCY_COMMIT,
    repository: facts.repository,
    ref: facts.ref,
    historicalPaths: facts.paths,
    historicalPackageHashes: facts.historicalPackageHashes,
    policyHashes: facts.policyHashes
  }
}
function checkRemediationLineage(root) {
  const head = gitText(root, ['rev-parse', 'HEAD'])
  const isAncestor = (ancestor, descendant) => {
    try {
      gitText(root, ['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch {
      return false
    }
  }
  const showHash = (spec) => sha256(gitBytes(root, ['show', spec]))
  const paths = {
    baseToHarness: changedPaths(root, `${BASE}..${HARNESS_BASELINE}`),
    harnessToPolicy: changedPaths(root, `${HARNESS_BASELINE}..${IMAGE_POLICY_COMMIT}`),
    policyToR: changedPaths(root, `${IMAGE_POLICY_COMMIT}..${DEPENDENCY_BASELINE}`),
    baseToR: changedPaths(root, `${BASE}..${DEPENDENCY_BASELINE}`),
    rToD: changedPaths(root, `${DEPENDENCY_BASELINE}..${DEPENDENCY_COMMIT}`),
    dToG: changedPaths(root, `${DEPENDENCY_COMMIT}..${head}`),
    rToG: changedPaths(root, `${DEPENDENCY_BASELINE}..${head}`)
  }
  const historicalPackageHashes = {
    manifest: showHash(`${DEPENDENCY_BASELINE}:package.json`),
    lock: showHash(`${DEPENDENCY_BASELINE}:package-lock.json`)
  }
  const policyHashes = {
    parent: showHash(`${HARNESS_BASELINE}:${IMAGE_POLICY_PATH}`),
    reviewed: showHash(`${IMAGE_POLICY_COMMIT}:${IMAGE_POLICY_PATH}`),
    atR: showHash(`${DEPENDENCY_BASELINE}:${IMAGE_POLICY_PATH}`)
  }
  const lineage = validateRemediationLineageFacts({
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    head,
    githubSha: process.env.GITHUB_SHA,
    dependencyParent: gitText(root, ['rev-parse', `${DEPENDENCY_COMMIT}^`]),
    imagePolicyParent: gitText(root, ['rev-parse', `${IMAGE_POLICY_COMMIT}^`]),
    dirty: gitText(root, ['status', '--porcelain=v1']) !== '',
    ancestors: Object.fromEntries(
      [BASE, HARNESS_BASELINE, IMAGE_POLICY_COMMIT, DEPENDENCY_BASELINE, DEPENDENCY_COMMIT, head].map((commit) => [
        commit,
        isAncestor(commit, head)
      ])
    ),
    paths,
    historicalPackageHashes,
    policyHashes
  })
  const protectedHashes = {
    ...REMEDIATION_PACKAGE_HASHES,
    'src/renderer/src/components/Markdown.security.browser.test.ts':
      '6db0c57e6c756573af0eb3e58629f1e66220d46e5d3815073cac8d89e7507453',
    'src/renderer/src/components/Markdown.katex.browser.test.ts':
      'b5e25eb09fd3b9f163a689619567a7fe731bfd5f6a7bbc0e0fdd3ba543b54e4f',
    'src/renderer/src/components/Markdown.mermaid.browser.test.ts':
      'debbc0ce9f905eae876170d6946ebe597061cecf893914a44cc106fc68a8aaec',
    'src/renderer/src/components/Markdown.warmup.test.ts':
      '3538900da0323a9a322652971a4ddfd48124da61c3f4e1087eb1a9700c0dc549',
    'src/renderer/src/components/CodeBlock.test.ts': '0fac21156bf05ac73831daec44746aa8ffaa191831dceeaa42250aaa7c1b6c77',
    'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts':
      '21e62365f593ece4a3300b5fd271167f41a078887df3e813e48874f921c962ea',
    'scripts/ci/renderer-katex-unhandled-reporter.mjs':
      '6032dd30922e4248ca915e5ee362c1ca07516e3152a02eb0abb6901bb08b4ec7',
    'src/renderer/src/components/Markdown.tsx': '5f1d8910947f5b33de58b759d7bebf72088c1dfab26d013a8c9724640a62d994',
    'src/renderer/src/components/CodeBlock.tsx': '8cf23fdf6149cc1bdd20ef100a02a3fc6b28490f061aaf73fc7a997a8edfd09a',
    'src/renderer/index.html': '057d1a71cc042fa02c5d3a4e63c0c78dde1ea226348dcf62f8f0f4debbfa220a',
    'electron.vite.config.ts': '37b18ad210db7fdb88bbc153579e6af17128e49a7fa7bde56a86eab4f4ff6d2c',
    'scripts/design/renderer-inputs.ts': '668fe52adbe4b33d45e2a7081ff61b19093d313702e1e5c0e4ab6de944295ea3'
  }
  for (const [path, expected] of Object.entries(protectedHashes))
    if (fileHash(root, path).sha256 !== expected) fail(`GREEN_PROTECTED_BYTES:${path}`)
  return { ...lineage, protectedHashes }
}
export function checkGreenReport(reportPath, exitCode, logPath, attemptPath) {
  if (statSync(reportPath).size > 16 * 1024 * 1024) fail('GREEN_REPORT_SIZE')
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    fail('GREEN_REPORT_INVALID')
  }
  const results = Array.isArray(report.testResults) ? report.testResults : fail('GREEN_FILE_INVENTORY')
  const expectedFiles = [...new Set(GREEN_CASES.map(([file]) => file))].sort()
  const actualFiles = results.map((file) => relative(process.cwd(), resolve(file.name)).replaceAll('\\', '/')).sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) fail('GREEN_FILE_INVENTORY')
  const expectedCases = GREEN_CASES.map(([file, suite, title]) => JSON.stringify([file, [suite], title])).sort()
  const actualCases = []
  const assertions = []
  for (const file of results) {
    const name = relative(process.cwd(), resolve(file.name)).replaceAll('\\', '/')
    if (file.status !== 'passed' || file.message !== '' || !Array.isArray(file.assertionResults))
      fail('GREEN_FILE_FAILED')
    for (const assertion of file.assertionResults) {
      if (
        assertion.status !== 'passed' ||
        assertion.failureMessages?.length !== 0 ||
        !Array.isArray(assertion.ancestorTitles) ||
        assertion.ancestorTitles.length !== 1 ||
        typeof assertion.title !== 'string' ||
        assertion.fullName !== `${assertion.ancestorTitles[0]} ${assertion.title}`
      )
        fail('GREEN_ASSERTION_STATE')
      actualCases.push(JSON.stringify([name, assertion.ancestorTitles, assertion.title]))
      assertions.push(assertion)
    }
  }
  actualCases.sort()
  if (JSON.stringify(actualCases) !== JSON.stringify(expectedCases) || assertions.length !== 30)
    fail('GREEN_CASE_INVENTORY')
  if (
    report.success !== true ||
    report.numTotalTests !== 30 ||
    report.numPassedTests !== 30 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numTotalTestSuites !== GREEN_SUITE_COUNT ||
    report.numPassedTestSuites !== GREEN_SUITE_COUNT ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    exitCode !== 0 ||
    !logPath ||
    !attemptPath
  )
    fail('GREEN_SUMMARY_OR_EXIT')
  const logBytes = readFileSync(logPath)
  if (logBytes.length > 4 * 1024 * 1024) fail('GREEN_LOG_SIZE')
  const log = checkRawGreenLog(logBytes, 'GREEN_LOG_FAILURE')
  const expectedAttemptCases = GREEN_CASES.map(([file, suite, title]) => [file, [suite], title])
  const attempt = checkAttemptReport(attemptPath, {
    expectedPath: resolve(dirname(reportPath), 'attempt-evidence.json'),
    expectedCases: expectedAttemptCases,
    expectedFileCount: expectedFiles.length
  })
  return {
    files: actualFiles,
    cases: assertions.length,
    passed: 30,
    failed: 0,
    skipped: 0,
    pending: 0,
    todo: 0,
    retried: 0,
    suites: GREEN_SUITE_COUNT,
    log,
    attempt
  }
}
export function checkAudit(reportPath, exitCode = 0) {
  if (exitCode !== 0) fail('AUDIT_COMMAND_EXIT')
  if (statSync(reportPath).size > 8 * 1024 * 1024) fail('AUDIT_SIZE')
  const bytes = readFileSync(reportPath)
  let report
  try {
    report = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('AUDIT_JSON')
  }
  const counts = report.metadata?.vulnerabilities
  if (
    report.auditReportVersion !== 2 ||
    report.error !== undefined ||
    !counts ||
    !['info', 'low', 'moderate', 'high', 'critical', 'total'].every((key) => counts[key] === 0) ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities) ||
    Object.keys(report.vulnerabilities).length !== 0 ||
    !report.metadata?.dependencies ||
    !['prod', 'dev', 'optional', 'peer', 'total'].every(
      (key) => Number.isSafeInteger(report.metadata.dependencies[key]) && report.metadata.dependencies[key] >= 0
    ) ||
    report.metadata.dependencies.total <= 0 ||
    report.metadata.dependencies.total <
      Math.max(
        report.metadata.dependencies.prod,
        report.metadata.dependencies.dev,
        report.metadata.dependencies.optional,
        report.metadata.dependencies.peer
      )
  )
    fail('AUDIT_NOT_ZERO')
  return { bytes: bytes.byteLength, sha256: sha256(bytes), metadata: counts, vulnerabilities: {} }
}
export function checkNpmProducer(receiptPath, outputPath, kind, exitCode) {
  const receiptBytes = readFileSync(receiptPath)
  if (receiptBytes.length === 0 || receiptBytes.length > 16 * 1024) fail('NPM_PRODUCER_SIZE')
  let receipt
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'))
  } catch {
    fail('NPM_PRODUCER_JSON')
  }
  const argv =
    kind === 'audit'
      ? ['audit', '--include=dev', '--include=optional', '--include=peer', '--json']
      : [
          'sbom',
          '--sbom-format=cyclonedx',
          '--package-lock-only',
          '--include=dev',
          '--include=optional',
          '--include=peer'
        ]
  if (
    receipt.schema !== 1 ||
    receipt.producer !== 'npm' ||
    receipt.version !== '10.9.8' ||
    receipt.kind !== kind ||
    JSON.stringify(receipt.argv) !== JSON.stringify(argv) ||
    receipt.sourceCommit !== process.env.GITHUB_SHA ||
    receipt.runId !== process.env.GITHUB_RUN_ID ||
    receipt.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
    receipt.job !== process.env.GITHUB_JOB ||
    receipt.effectiveOmit !== '' ||
    receipt.exitCode !== exitCode ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(receipt.startedAt || '') ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(receipt.finishedAt || '') ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !Number.isFinite(Date.parse(receipt.finishedAt)) ||
    Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt) ||
    receipt.outputSha256 !== sha256(readFileSync(outputPath))
  )
    fail(`NPM_${kind.toUpperCase()}_PRODUCER_MISMATCH`)
  return { ...receipt, receiptSha256: sha256(receiptBytes) }
}
function lockPackageName(path, entry, rootPackage) {
  if (!path) return rootPackage.name || entry.name
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function npmBomRef(path, entry, rootPackage) {
  return `${lockPackageName(path, entry, rootPackage)}@${entry.version}`
}

function lockEdges(lock, path, entry, rootPackage) {
  const dependencies = {
    ...(entry.dependencies || {}),
    ...(entry.optionalDependencies || {}),
    ...(entry.peerDependencies || {})
  }
  if (!path) {
    Object.assign(dependencies, entry.devDependencies || {})
  }
  const edges = new Set()
  for (const name of Object.keys(dependencies)) {
    const target = lockDependencyPath(lock, path, name)
    if (!target) {
      if (entry.peerDependenciesMeta?.[name]?.optional === true) continue
      fail(`SBOM_LOCK_EDGE_TARGET:${path}:${name}`)
    }
    const targetEntry = lock.packages[target]
    if (!targetEntry?.version) fail(`SBOM_LOCK_EDGE_VERSION:${target}`)
    edges.add(npmBomRef(target, targetEntry, rootPackage))
  }
  return [...edges].sort()
}

function componentPath(component) {
  const values = (component.properties || [])
    .filter((property) => property.name === 'cdx:npm:package:path')
    .map((property) => property.value)
  if (values.length !== 1 || typeof values[0] !== 'string') fail('SBOM_COMPONENT_PATH')
  return values[0].replaceAll('\\', '/').replace(/^\.\//u, '')
}

function licenseIdentifiers(component) {
  if (!Array.isArray(component.licenses) || component.licenses.length === 0) return []
  return component.licenses.flatMap((entry) => [entry.license?.id, entry.expression].filter(Boolean))
}

export function checkSbom(reportPath, lock, exitCode = 0, sourceRoot = process.cwd()) {
  if (exitCode !== 0) fail('SBOM_COMMAND_EXIT')
  if (statSync(reportPath).size === 0 || statSync(reportPath).size > 64 * 1024 * 1024) fail('SBOM_SIZE')
  const bytes = readFileSync(reportPath)
  let sbom
  try {
    sbom = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('SBOM_JSON')
  }
  const components = sbom.components
  if (
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.5' ||
    !Array.isArray(components) ||
    !Array.isArray(sbom.dependencies)
  )
    fail('SBOM_SCHEMA')
  const tool = sbom.metadata?.tools?.find(
    (entry) => entry.vendor === 'npm' && entry.name === 'cli' && entry.version === '10.9.8'
  )
  if (!tool) fail('SBOM_TOOL_IDENTITY')
  const packages = lock.packages || {}
  const rootPackage = packages['']
  if (!rootPackage?.name || !rootPackage.version || !sbom.metadata?.component) fail('SBOM_ROOT_IDENTITY')
  const sourcePath = resolve(sourceRoot)
  const sourceFolder = basename(sourcePath)
  const sourceParent = basename(dirname(sourcePath))
  const rootDisplayName =
    (sourceParent.startsWith('@') ? `${sourceParent}/${sourceFolder}` : sourceFolder) || rootPackage.name
  const expected = Object.entries(packages).filter(([, entry]) => entry?.version)
  const componentByPath = new Map()
  const allComponents = [...components, sbom.metadata.component]
  for (const component of allComponents) {
    if (
      typeof component['bom-ref'] !== 'string' ||
      typeof component.name !== 'string' ||
      typeof component.version !== 'string'
    )
      fail('SBOM_COMPONENT_REFERENCE')
    if (component === sbom.metadata.component) continue
    const path = componentPath(component)
    if (componentByPath.has(path)) fail('SBOM_DUPLICATE_PATH')
    componentByPath.set(path, component)
  }
  if (componentByPath.size !== expected.filter(([path]) => path !== '').length) fail('SBOM_COMPONENT_COVERAGE')
  const expectedRefCounts = new Map()
  const expectedEdges = new Map()
  const componentsByRef = new Map()
  for (const [path, entry] of expected) {
    const name = lockPackageName(path, entry, rootPackage)
    const ref = npmBomRef(path, entry, rootPackage)
    expectedRefCounts.set(ref, (expectedRefCounts.get(ref) || 0) + 1)
    const previousEdges = expectedEdges.get(ref)
    const edges = lockEdges(lock, path, entry, rootPackage)
    if (previousEdges && JSON.stringify(previousEdges) !== JSON.stringify(edges))
      fail(`SBOM_DUPLICATE_REF_EDGE_AMBIGUITY:${ref}`)
    expectedEdges.set(ref, edges)
    if (!path) {
      const rootComponent = sbom.metadata.component
      const rootPaths = Array.isArray(rootComponent.properties)
        ? rootComponent.properties.filter((property) => property?.name === 'cdx:npm:package:path')
        : []
      if (
        rootComponent.name !== rootDisplayName ||
        rootComponent.version !== entry.version ||
        rootComponent['bom-ref'] !== ref ||
        rootComponent.purl !== `pkg:npm/${name.replace(/^@/u, '%40')}@${entry.version}` ||
        rootPaths.length !== 1 ||
        rootPaths[0].value !== ''
      )
        fail('SBOM_ROOT_IDENTITY')
      continue
    }
    const component = componentByPath.get(path)
    if (!component || component.name !== name || component.version !== entry.version || component['bom-ref'] !== ref)
      fail(`SBOM_LOCK_NODE_OR_PATH_MISSING:${path}`)
    componentsByRef.set(ref, [...(componentsByRef.get(ref) || []), component])
    if (entry.integrity) {
      const integrityParts = entry.integrity
        .split(/\s+/u)
        .map((part) => {
          const separator = part.indexOf('-')
          const algorithm = part.slice(0, separator)
          const digest = part.slice(separator + 1).split('?')[0]
          if (separator < 0 || !digest) return null
          try {
            return { alg: `SHA-${algorithm.slice(3)}`, content: Buffer.from(digest, 'base64').toString('hex') }
          } catch {
            return null
          }
        })
        .filter(Boolean)
      if (!integrityParts.length) fail(`SBOM_LOCK_INTEGRITY_SCHEMA:${path}`)
      const matches = integrityParts.some((expectedHash) =>
        (component.hashes || []).some(
          (actualHash) => actualHash.alg === expectedHash.alg && actualHash.content === expectedHash.content
        )
      )
      if (!matches) fail(`SBOM_INTEGRITY_MISMATCH:${path}`)
    }
    const resolved = entry.resolved
    if (
      resolved &&
      !(component.externalReferences || []).some(
        (reference) => reference.type === 'distribution' && reference.url === resolved
      )
    )
      fail(`SBOM_RESOLVED_URL_MISSING:${path}`)
    const declaredLicense = entry.license
    const emittedLicenses = licenseIdentifiers(component)
    if (typeof declaredLicense === 'string') {
      if (!emittedLicenses.includes(declaredLicense)) fail(`SBOM_LICENSE_MISMATCH:${path}`)
    } else if (path === 'node_modules/khroma' && entry.version === '2.1.0') {
      if (
        emittedLicenses.length ||
        sha256(readFileSync(resolve(process.cwd(), 'node_modules/khroma/license'))) !==
          '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49'
      )
        fail('SBOM_KHROMA_LICENSE_ADDENDUM')
    } else if (!emittedLicenses.length) fail(`SBOM_LICENSE_MISSING:${path}`)
  }
  const dependencyRefCounts = new Map()
  const actualEdges = new Map()
  for (const dependency of sbom.dependencies) {
    if (typeof dependency?.ref !== 'string' || !Array.isArray(dependency.dependsOn)) fail('SBOM_DEPENDENCY_EDGE_SCHEMA')
    dependencyRefCounts.set(dependency.ref, (dependencyRefCounts.get(dependency.ref) || 0) + 1)
    const edges = [...new Set(dependency.dependsOn)].sort()
    if (edges.length !== dependency.dependsOn.length) fail('SBOM_DUPLICATE_EDGE')
    const previous = actualEdges.get(dependency.ref)
    if (previous && JSON.stringify(previous) !== JSON.stringify(edges))
      fail(`SBOM_DUPLICATE_REF_EDGE_DIVERGENCE:${dependency.ref}`)
    actualEdges.set(dependency.ref, edges)
  }
  if (JSON.stringify([...dependencyRefCounts].sort()) !== JSON.stringify([...expectedRefCounts].sort()))
    fail('SBOM_DEPENDENCY_NODE_SET')
  for (const [ref, edges] of expectedEdges)
    if (JSON.stringify(actualEdges.get(ref)) !== JSON.stringify(edges)) fail(`SBOM_DEPENDENCY_EDGE_MISMATCH:${ref}`)
  const katex = componentByPath.get('node_modules/katex')
  const mermaid = componentByPath.get('node_modules/mermaid')
  const streamdown = componentByPath.get('node_modules/streamdown')
  if (
    katex?.version !== PATCHED_KATEX.version ||
    mermaid?.version !== '11.17.0' ||
    streamdown?.version !== '2.5.0' ||
    !licenseIdentifiers(katex).includes('MIT') ||
    !licenseIdentifiers(mermaid).includes('MIT') ||
    !licenseIdentifiers(streamdown).includes('Apache-2.0')
  )
    fail('SBOM_RENDERER_IDENTITY_OR_LICENSE')
  return {
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    componentCount: components.length,
    dependencyCount: sbom.dependencies.length,
    lockNodeCount: expected.length,
    duplicateBomRefCount: [...expectedRefCounts.values()].filter((count) => count > 1).length,
    duplicateBomRefEdges: 'reconciled by ref only after component path inventory is complete; divergent edges fail',
    supplementalLicenseAddendum: {
      component: 'khroma@2.1.0',
      lockPath: 'node_modules/khroma',
      materialPath: 'node_modules/khroma/license',
      materialSha256: '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49',
      reason: 'npm CycloneDX omits this package license metadata; installed license bytes verified separately'
    },
    tool: { vendor: tool.vendor, name: tool.name, version: tool.version }
  }
}
export function validateRemediationPackageRecords(manifest, lock, installedVersion) {
  if (
    manifest.overrides?.['mermaid@11.17.0']?.katex !== PATCHED_KATEX.version ||
    manifest.dependencies?.katex ||
    manifest.devDependencies?.katex
  )
    fail('GREEN_OVERRIDE_SCOPE')
  const katex = lock.packages?.['node_modules/katex']
  if (
    !katex ||
    katex.version !== PATCHED_KATEX.version ||
    katex.resolved !== PATCHED_KATEX.resolved ||
    katex.integrity !== PATCHED_KATEX.integrity
  )
    fail('GREEN_LOCK_KATEX_IDENTITY')
  const katexNodes = Object.entries(lock.packages || {}).filter(([path]) => /(^|\/)node_modules\/katex$/u.test(path))
  if (katexNodes.length !== 1 || katexNodes[0][0] !== 'node_modules/katex') fail('GREEN_KATEX_DUPLICATE_OR_NESTED')
  for (const [path, expected] of Object.entries(FROZEN_RENDERER_PACKAGES)) {
    const entry = lock.packages?.[path]
    if (!entry || entry.version !== expected.version || entry.integrity !== expected.integrity)
      fail(`GREEN_FROZEN_PACKAGE:${path}`)
  }
  const commander = lock.packages?.['node_modules/katex/node_modules/commander']
  if (commander && commander.version !== '8.3.0') fail('GREEN_COMMANDER_DRIFT')
  if (installedVersion !== PATCHED_KATEX.version) fail('GREEN_INSTALLED_KATEX_IDENTITY')
  return { lock, installedVersion }
}
function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    )
  return value
}
export function validateLockDelta(baseLock, currentLock) {
  const before = baseLock.packages || {}
  const after = currentLock.packages || {}
  const beforeKeys = Object.keys(before).sort()
  const afterKeys = Object.keys(after).sort()
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) fail('GREEN_LOCK_NODE_SET_CHANGED')
  for (const key of beforeKeys) {
    if (key === 'node_modules/katex') continue
    if (JSON.stringify(stableJson(before[key])) !== JSON.stringify(stableJson(after[key])))
      fail(`GREEN_UNRELATED_LOCK_CHANGE:${key}`)
  }
  const old = before['node_modules/katex']
  if (
    !old ||
    old.version !== OLD_KATEX.version ||
    old.resolved !== OLD_KATEX.resolved ||
    old.integrity !== OLD_KATEX.integrity
  )
    fail('GREEN_BASELINE_KATEX_IDENTITY')
  const patched = after['node_modules/katex']
  if (
    !patched ||
    patched.version !== PATCHED_KATEX.version ||
    patched.resolved !== PATCHED_KATEX.resolved ||
    patched.integrity !== PATCHED_KATEX.integrity
  )
    fail('GREEN_PATCHED_KATEX_IDENTITY')
  return { packageNodeCount: beforeKeys.length, changedPackageKeys: ['node_modules/katex'] }
}
function platformAllowed(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true
  const positive = values.filter((value) => !value.startsWith('!'))
  const negative = values.filter((value) => value.startsWith('!')).map((value) => value.slice(1))
  if (negative.includes(current)) return false
  return positive.length === 0 || positive.includes(current)
}

function lockDependencyPath(lock, fromPath, name) {
  let cursor = fromPath
  for (;;) {
    const candidate = cursor ? `${cursor}/node_modules/${name}` : `node_modules/${name}`
    if (lock.packages?.[candidate]) return candidate
    const marker = cursor.lastIndexOf('/node_modules/')
    if (marker >= 0) cursor = cursor.slice(0, marker)
    else if (cursor.startsWith('node_modules/')) cursor = ''
    else break
  }
  return null
}

export function checkNpmInstalledGraph(
  lsPath,
  lsExit,
  explainPath,
  explainExit,
  lock,
  root = process.cwd(),
  mermaidExplainPath,
  mermaidExplainExit
) {
  if (lsExit !== 0 || explainExit !== 0 || mermaidExplainExit !== 0 || !mermaidExplainPath)
    fail('NPM_GRAPH_COMMAND_EXIT')
  const lsBytes = readFileSync(lsPath)
  const explainBytes = readFileSync(explainPath)
  const mermaidExplainBytes = readFileSync(mermaidExplainPath)
  if (
    lsBytes.length > 32 * 1024 * 1024 ||
    explainBytes.length > 4 * 1024 * 1024 ||
    mermaidExplainBytes.length > 4 * 1024 * 1024
  )
    fail('NPM_GRAPH_SIZE')
  let tree
  let explain
  let mermaidExplain
  try {
    tree = JSON.parse(lsBytes.toString('utf8'))
    explain = JSON.parse(explainBytes.toString('utf8'))
    mermaidExplain = JSON.parse(mermaidExplainBytes.toString('utf8'))
  } catch {
    fail('NPM_GRAPH_JSON')
  }
  if (
    !tree ||
    !tree.dependencies ||
    !Array.isArray(tree.problems || []) ||
    (tree.problems || []).length !== 0 ||
    tree.invalid === true ||
    tree.extraneous === true
  )
    fail('NPM_LS_INVALID_OR_PROBLEMS')
  if (!lock?.packages || !Array.isArray(explain) || !Array.isArray(mermaidExplain))
    fail('NPM_LS_LOCK_OR_EXPLAIN_SCHEMA')
  const currentOs = process.platform === 'win32' ? 'win32' : process.platform
  const currentCpu = process.arch
  const expected = new Map()
  const platformOptionalMissing = []
  const prunedOptionalDescendants = []
  const queued = ['']
  while (queued.length) {
    const path = queued.pop()
    if (expected.has(path)) continue
    const entry = lock.packages[path]
    if (!entry) fail(`NPM_LOCK_REQUIRED_EDGE_MISSING:${path}`)
    if (path && (!platformAllowed(entry.os, currentOs) || !platformAllowed(entry.cpu, currentCpu))) {
      if (entry.optional !== true) fail(`NPM_LOCK_REQUIRED_PLATFORM_PACKAGE:${path}`)
      platformOptionalMissing.push({ path, platform: currentOs, cpu: currentCpu })
      continue
    }
    if (entry.link) fail(`NPM_LOCK_LINK_UNCLASSIFIED:${path}`)
    expected.set(path, entry)
    const names = new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
      ...Object.keys(entry.peerDependencies || {}),
      ...(path === '' ? Object.keys(entry.devDependencies || {}) : [])
    ])
    for (const name of names) {
      const target = lockDependencyPath(lock, path, name)
      if (!target) {
        if (entry.peerDependenciesMeta?.[name]?.optional === true) continue
        fail(`NPM_LOCK_REQUIRED_EDGE_MISSING:${path}:${name}`)
      }
      queued.push(target)
    }
  }
  for (const [path, entry] of Object.entries(lock.packages))
    if (path && entry?.version && !entry.link && !expected.has(path)) {
      if (entry.optional !== true) fail(`NPM_LOCK_UNREACHABLE_REQUIRED_NODE:${path}`)
      if (platformAllowed(entry.os, currentOs) && platformAllowed(entry.cpu, currentCpu))
        prunedOptionalDescendants.push(path)
    }
  const installed = new Map()
  const installedEdges = new Map()
  const absentOptional = []
  const absentOptionalPeers = []
  const isAbsentOptionalPeer = (parentPath, name, record, target) => {
    const parent = lock.packages[parentPath]
    if (
      target ||
      parent?.peerDependenciesMeta?.[name]?.optional !== true ||
      typeof parent.peerDependencies?.[name] !== 'string' ||
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).length !== 0
    )
      return false
    if (!absentOptionalPeers.some((edge) => edge.parent === parentPath && edge.name === name))
      absentOptionalPeers.push({ parent: parentPath, name, declaredSpec: parent.peerDependencies[name] })
    return true
  }
  function visit(dependencies, parentPath = '') {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
      fail('NPM_LS_DEPENDENCY_SCHEMA')
    for (const [name, record] of Object.entries(dependencies)) {
      const edgeTarget = lockDependencyPath(lock, parentPath, name)
      if (isAbsentOptionalPeer(parentPath, name, record, edgeTarget)) continue
      if (!edgeTarget) fail(`NPM_LS_UNDECLARED_EDGE:${parentPath}:${name}`)
      if (
        record &&
        typeof record === 'object' &&
        !Array.isArray(record) &&
        typeof record.path !== 'string' &&
        typeof record.version !== 'string'
      ) {
        const entry = lock.packages[edgeTarget]
        const parent = lock.packages[parentPath]
        if (
          !entry?.optional ||
          !(parent?.optionalDependencies?.[name] || parent?.peerDependenciesMeta?.[name]?.optional) ||
          expected.has(edgeTarget)
        )
          fail(`NPM_LS_REQUIRED_NODE_ABSENT:${parentPath}:${name}`)
        absentOptional.push(edgeTarget)
        continue
      }
      if (
        !record ||
        typeof record !== 'object' ||
        typeof record.version !== 'string' ||
        typeof record.path !== 'string'
      )
        fail('NPM_LS_PHYSICAL_PATH_REQUIRED')
      const absolute = resolve(root, record.path)
      const relativePath = relative(resolve(root), absolute).replaceAll('\\', '/')
      if (!relativePath.startsWith('node_modules/') || relativePath.includes('../')) fail('NPM_LS_PATH_ESCAPE')
      const lockPath = relativePath
      const locked = lock.packages[lockPath]
      if (!locked || locked.version !== record.version) fail(`NPM_LS_NOT_IN_LOCK:${lockPath}`)
      const packageJson = JSON.parse(readFileSync(resolve(absolute, 'package.json'), 'utf8'))
      if (packageJson.name !== name || packageJson.version !== record.version) fail(`NPM_LS_PACKAGE_BYTES:${lockPath}`)
      const existing = installed.get(lockPath)
      if (existing && existing.version !== record.version) fail(`NPM_LS_DUPLICATE_IDENTITY:${lockPath}`)
      installed.set(lockPath, { name, version: record.version, path: lockPath })
      const childEdges = []
      for (const [childName, child] of Object.entries(record.dependencies || {})) {
        const target = lockDependencyPath(lock, lockPath, childName)
        if (isAbsentOptionalPeer(lockPath, childName, child, target)) continue
        if (!target) fail(`NPM_LS_UNDECLARED_EDGE:${lockPath}:${childName}`)
        if (!child || typeof child !== 'object') fail('NPM_LS_CHILD_SCHEMA')
        if (typeof child.path === 'string')
          childEdges.push(relative(resolve(root), resolve(root, child.path)).replaceAll('\\', '/'))
        else if (lock.packages[target]?.optional === true && !expected.has(target)) absentOptional.push(target)
        else fail('NPM_LS_CHILD_PHYSICAL_PATH_REQUIRED')
      }
      if (record.dependencies) {
        if (
          installedEdges.has(lockPath) &&
          JSON.stringify(installedEdges.get(lockPath).sort()) !== JSON.stringify(childEdges.sort())
        )
          fail(`NPM_LS_DUPLICATE_LOGICAL_EDGE_DIVERGENCE:${lockPath}`)
        installedEdges.set(lockPath, childEdges)
      }
      if (record.invalid === true || record.extraneous === true || record.problems?.length) fail('NPM_LS_NODE_INVALID')
      if (record.dependencies) visit(record.dependencies, lockPath)
    }
  }
  visit(tree.dependencies)
  installedEdges.set(
    '',
    Object.entries(tree.dependencies)
      .filter(([, record]) => typeof record?.path === 'string')
      .map(([, record]) => relative(resolve(root), resolve(root, record.path)).replaceAll('\\', '/'))
  )
  if (installed.size !== expected.size - 1) fail('NPM_INSTALLED_LOCK_NODE_COUNT')
  for (const [path, entry] of expected) {
    const actual = installed.get(path)
    if (path && (!actual || actual.version !== entry.version)) fail(`NPM_INSTALLED_LOCK_NODE_MISSING:${path}`)
    const edgeNames = {
      ...(entry.dependencies || {}),
      ...(entry.optionalDependencies || {}),
      ...(entry.peerDependencies || {}),
      ...(path === '' ? entry.devDependencies || {} : {})
    }
    const expectedChildren = []
    for (const name of Object.keys(edgeNames)) {
      const target = lockDependencyPath(lock, path, name)
      if (!target) {
        if (entry.peerDependenciesMeta?.[name]?.optional === true && entry.peerDependencies?.[name]) continue
        fail(`NPM_LOCK_REQUIRED_EDGE_MISSING:${path}:${name}`)
      }
      if (!expected.has(target)) {
        if (lock.packages[target]?.optional === true && !expected.has(target)) continue
        fail(`NPM_LOCK_REQUIRED_EDGE_PLATFORM_MISSING:${path}:${name}`)
      }
      expectedChildren.push(target)
    }
    const actualChildren = (installedEdges.get(path) || []).sort()
    if (JSON.stringify(actualChildren) !== JSON.stringify(expectedChildren.sort()))
      fail(`NPM_INSTALLED_EDGE_SET_MISMATCH:${path}`)
  }
  for (const path of installed.keys()) if (!expected.has(path)) fail(`NPM_INSTALLED_EXTRANEOUS:${path}`)
  const found = [...installed.values()].filter((entry) => entry.name === 'katex')
  const rendererPackages = Object.fromEntries(
    ['mermaid', 'streamdown'].map((name) => [name, [...installed.values()].filter((entry) => entry.name === name)])
  )
  if (found.length !== 1 || found[0].path !== 'node_modules/katex' || found[0].version !== PATCHED_KATEX.version)
    fail('NPM_INSTALLED_KATEX_COPIES')
  if (
    rendererPackages.mermaid.length !== 1 ||
    rendererPackages.mermaid[0].path !== 'node_modules/mermaid' ||
    rendererPackages.mermaid[0].version !== '11.17.0' ||
    rendererPackages.streamdown.length !== 1 ||
    rendererPackages.streamdown[0].path !== 'node_modules/streamdown' ||
    rendererPackages.streamdown[0].version !== '2.5.0'
  )
    fail('NPM_FROZEN_RENDERER_GRAPH')
  const streamdown = lock.packages['node_modules/streamdown']
  const mermaid = lock.packages['node_modules/mermaid']
  if (
    !streamdown?.dependencies?.mermaid ||
    lockDependencyPath(lock, 'node_modules/streamdown', 'mermaid') !== 'node_modules/mermaid' ||
    !mermaid?.dependencies?.katex ||
    lockDependencyPath(lock, 'node_modules/mermaid', 'katex') !== 'node_modules/katex'
  )
    fail('NPM_LOCK_RENDERER_EDGE_CHAIN')
  const explanations = explain.filter(
    (entry) =>
      entry?.name === 'katex' && entry.version === PATCHED_KATEX.version && entry.location === 'node_modules/katex'
  )
  if (
    explanations.length !== 1 ||
    !Array.isArray(explanations[0].dependents) ||
    !explanations[0].dependents.some(
      (dependent) =>
        dependent.name === 'katex' &&
        dependent.type === 'prod' &&
        dependent.spec === '0.18.2' &&
        dependent.rawSpec === mermaid.dependencies.katex &&
        dependent.overridden === true &&
        !Object.hasOwn(dependent, 'error') &&
        dependent?.from?.name === 'mermaid' &&
        dependent.from.version === '11.17.0' &&
        dependent.from.location === 'node_modules/mermaid'
    )
  )
    fail('NPM_EXPLAIN_KATEX_CHAIN')
  const mermaidExplanations = mermaidExplain.filter(
    (entry) => entry?.name === 'mermaid' && entry.version === '11.17.0' && entry.location === 'node_modules/mermaid'
  )
  if (
    mermaidExplanations.length !== 1 ||
    !Array.isArray(mermaidExplanations[0].dependents) ||
    !mermaidExplanations[0].dependents.some(
      (dependent) =>
        dependent.name === 'mermaid' &&
        dependent.type === 'prod' &&
        dependent.spec === streamdown.dependencies.mermaid &&
        dependent.rawSpec === undefined &&
        dependent.overridden !== true &&
        !Object.hasOwn(dependent, 'error') &&
        dependent?.from?.name === 'streamdown' &&
        dependent.from.version === '2.5.0' &&
        dependent.from.location === 'node_modules/streamdown'
    )
  )
    fail('NPM_EXPLAIN_MERMAID_CHAIN')
  return {
    npmLs: {
      exitCode: 0,
      bytes: lsBytes.length,
      sha256: sha256(lsBytes),
      physicalPackageCount: installed.size,
      katexCopies: found,
      rendererPackages,
      platformOptionalMissing,
      prunedOptionalDescendants,
      absentOptionalPeers
    },
    npmExplain: {
      exitCode: 0,
      bytes: explainBytes.length,
      sha256: sha256(explainBytes),
      katexResolution: found[0],
      immediateDependent: 'mermaid@11.17.0',
      mermaidExplain: {
        exitCode: 0,
        bytes: mermaidExplainBytes.length,
        sha256: sha256(mermaidExplainBytes),
        immediateDependent: 'streamdown@2.5.0'
      }
    }
  }
}
function checkRemediationPackage(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  const baseLock = JSON.parse(gitBytes(root, ['show', `${DEPENDENCY_BASELINE}:package-lock.json`]).toString('utf8'))
  const lockDelta = validateLockDelta(baseLock, lock)
  const installedPath = realpathSync(resolve(root, 'node_modules/katex'))
  const installed = JSON.parse(readFileSync(resolve(installedPath, 'package.json'), 'utf8'))
  validateRemediationPackageRecords(manifest, lock, installed.version)
  return {
    lockSha256: fileHash(root, 'package-lock.json').sha256,
    manifestSha256: fileHash(root, 'package.json').sha256,
    lockDelta,
    installedKaTeX: {
      version: installed.version,
      realpath: installedPath,
      packageJsonSha256: fileHash(installedPath, 'package.json').sha256
    },
    lock
  }
}
async function mainGreen(args, root) {
  const lineage = checkRemediationLineage(root)
  for (const [path, expected] of Object.entries(REMEDIATION_PACKAGE_HASHES))
    if (fileHash(root, path).sha256 !== expected) fail(`GREEN_PACKAGE_BYTES:${path}`)
  const dependency = checkRemediationPackage(root)
  const testExit = Number(args.get('test-exit'))
  if (testExit !== 0) fail('GREEN_TEST_EXIT')
  const logPath = resolve(root, args.get('log'))
  const logBytes = readFileSync(logPath)
  if (logBytes.byteLength > 4 * 1024 * 1024 || !Buffer.from(logBytes.toString('utf8'), 'utf8').equals(logBytes))
    fail('GREEN_LOG_BYTES')
  const logText = logBytes.toString('utf8')
  if (/^\s*FAIL\s/u.test(logText) || /Failed Tests|unhandledRejection|Unhandled Error/iu.test(logText))
    fail('GREEN_LOG_FAILURE_MARKER')
  const tests = checkGreenReport(
    resolve(root, args.get('report')),
    testExit,
    resolve(root, args.get('log')),
    resolve(root, args.get('attempt-report'))
  )
  const outPath = resolve(root, args.get('out'))
  const expectedRunErrors = resolve(dirname(resolve(root, args.get('log'))), 'vitest-run-errors.json')
  const runErrors = checkRunErrors(resolve(root, args.get('run-errors')), expectedRunErrors)
  if (process.version !== 'v22.22.3' || process.env.NPM_VERSION !== '10.9.8') fail('TOOLCHAIN_PIN')
  const origins = checkHarnessOrigins(dirname(outPath), PATCHED_KATEX.version)
  const audit = checkAudit(resolve(root, args.get('audit')), Number(args.get('audit-exit')))
  const sbom = checkSbom(resolve(root, args.get('sbom')), dependency.lock, Number(args.get('sbom-exit')), root)
  audit.producer = checkNpmProducer(
    resolve(root, args.get('audit-producer')),
    resolve(root, args.get('audit')),
    'audit',
    Number(args.get('audit-exit'))
  )
  sbom.producer = checkNpmProducer(
    resolve(root, args.get('sbom-producer')),
    resolve(root, args.get('sbom')),
    'sbom',
    Number(args.get('sbom-exit'))
  )
  const npmGraph = checkNpmInstalledGraph(
    resolve(root, args.get('npm-ls')),
    Number(args.get('npm-ls-exit')),
    resolve(root, args.get('npm-explain')),
    Number(args.get('npm-explain-exit')),
    dependency.lock,
    root,
    resolve(root, args.get('npm-explain-mermaid')),
    Number(args.get('npm-explain-mermaid-exit'))
  )
  const evidenceErrorsPath = resolve(root, args.get('evidence-errors'))
  const expectedEvidenceErrorsPath = resolve(
    dirname(resolve(root, args.get('evidence-report'))),
    'evidence-run-errors.json'
  )
  const focusedEvidence = checkEvidenceSuite(
    resolve(root, args.get('evidence-report')),
    resolve(root, args.get('evidence-log')),
    Number(args.get('evidence-exit')),
    evidenceErrorsPath,
    expectedEvidenceErrorsPath,
    resolve(root, args.get('evidence-attempt-report'))
  )
  let productionGraph = { status: 'UNKNOWN: observational build did not produce a validated byte-equality report' }
  const buildEvidencePath = resolve(root, args.get('build-evidence') || '')
  if (args.get('build-evidence') && existsSync(buildEvidencePath)) {
    if (statSync(buildEvidencePath).size > 64 * 1024 * 1024) fail('GREEN_BUILD_EVIDENCE_SIZE')
    const buildBytes = readFileSync(buildEvidencePath)
    const build = JSON.parse(buildBytes.toString('utf8'))
    const buildRun = build.buildRun
    const graphPath = resolve(root, args.get('build-graph'))
    if (!existsSync(graphPath) || statSync(graphPath).size > 64 * 1024 * 1024) fail('GREEN_BUILD_GRAPH_MISSING_OR_SIZE')
    const graphBytes = readFileSync(graphPath)
    if (sha256(graphBytes) !== build.graphSha256) fail('GREEN_BUILD_GRAPH_HASH')
    let observedGraph
    try {
      observedGraph = JSON.parse(graphBytes.toString('utf8'))
    } catch {
      fail('GREEN_BUILD_GRAPH_JSON')
    }
    const graphSummary = await validateGraph(observedGraph, build.observedInventory, root)
    const ordinaryEquality = compareInventories(build.ordinaryInventory, build.observedInventory)
    if (
      build.schema !== 2 ||
      build.evidence !== 'PRODUCTION_RENDERER_GRAPH_AND_BYTES_VERIFIED' ||
      build.sourceCommit !== process.env.GITHUB_SHA ||
      build.profile !== (process.env.METIS_PACKAGE_PROFILE || 'full') ||
      !Number.isSafeInteger(build.ordinaryObservedByteEquality?.fileCount) ||
      build.ordinaryObservedByteEquality.fileCount <= 0 ||
      !/^[a-f0-9]{64}$/u.test(build.ordinaryObservedByteEquality?.sha256 || '') ||
      !/^[a-f0-9]{64}$/u.test(build.graphSha256 || '') ||
      !Array.isArray(build.ordinaryInventory) ||
      !Array.isArray(build.observedInventory) ||
      ordinaryEquality.fileCount !== build.ordinaryObservedByteEquality.fileCount ||
      ordinaryEquality.sha256 !== build.ordinaryObservedByteEquality.sha256 ||
      JSON.stringify(graphSummary) !== JSON.stringify(build.graph) ||
      JSON.stringify(observedGraph.buildRun) !== JSON.stringify(buildRun) ||
      build.katexArchive?.integrity !== PATCHED_KATEX.integrity ||
      build.katexArchive?.installedPackageBytesMatchSRIArchive !== true ||
      !Array.isArray(build.mermaidResidue?.knownEmbeddedOldKaTeX) ||
      build.mermaidResidue.knownEmbeddedOldKaTeX.length === 0 ||
      build.mermaidResidue.embeddedComponentAddendum?.advisory !== 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923' ||
      build.mermaidResidue.embeddedComponentAddendum?.shippedStatus?.startsWith('UNKNOWN') !== true ||
      !buildRun ||
      buildRun.schema !== 1 ||
      buildRun.sourceCommit !== process.env.GITHUB_SHA ||
      buildRun.runId !== process.env.GITHUB_RUN_ID ||
      buildRun.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
      buildRun.job !== process.env.GITHUB_JOB ||
      buildRun.runnerOs !== process.env.RUNNER_OS ||
      buildRun.profile !== (process.env.METIS_PACKAGE_PROFILE || 'full') ||
      buildRun.packageTarget !== process.env.RENDERER_PACKAGE_TARGET ||
      buildRun.ordinaryBuildExitCode !== 0 ||
      buildRun.observedBuildExitCode !== 0
    )
      fail('GREEN_BUILD_EVIDENCE_BINDING')
    productionGraph = {
      status: 'observed-production-renderer-and-worker-graph-byte-identical',
      bytes: buildBytes.length,
      sha256: sha256(buildBytes),
      sourceCommit: build.sourceCommit,
      runId: buildRun.runId,
      runAttempt: buildRun.runAttempt,
      job: buildRun.job,
      runnerOs: buildRun.runnerOs,
      profile: build.profile,
      packageTarget: buildRun.packageTarget,
      graph: build.graph,
      katexArchive: build.katexArchive,
      mermaidResidue: build.mermaidResidue
    }
  }
  const result = {
    schema: 1,
    evidence: 'RENDERER_BROWSER_GREEN_ONLY',
    securityQualification: false,
    scope: {
      advisory: 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923',
      rendererCohort: 'five-file 30-case browser/source cohort'
    },
    source: {
      ...lineage,
      commit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runnerOs: process.env.RUNNER_OS || process.platform
    },
    toolchain: {
      node: process.version,
      npm: process.env.NPM_VERSION,
      browser: 'Playwright Chromium from frozen lockfile',
      vitestJsonReporter: '4.1.11 JsonTestResults'
    },
    dependency,
    browserOrigins: origins,
    tests,
    testExitCode: testExit,
    testReport: {
      bytes: statSync(resolve(root, args.get('report'))).size,
      sha256: sha256(readFileSync(resolve(root, args.get('report'))))
    },
    testLog: { bytes: logBytes.byteLength, sha256: sha256(logBytes) },
    unhandledErrors: runErrors,
    audit,
    sbom,
    npmGraph,
    focusedEvidenceTests: focusedEvidence,
    productionGraph,
    shippingStatus: 'UNKNOWN: no same-final-SHA packaged candidate evidence was supplied to this browser job'
  }
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log('renderer-katex-provenance:RENDERER_BROWSER_GREEN_ONLY')
}
function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = process.cwd()
  if (args.get('mode') === 'remediation-green') return mainGreen(args, root)
  checkCausalParserFixtures()
  const lineage = checkSourceLineage(root)
  if (fileHash(root, KATEX_TEST_PATH).sha256 !== '29a45a57d2223da01ed632e2ada5d7a1ab84997add53b74371b5e2324fbb17f0')
    fail('KATEX_CAUSAL_SOURCE_BINDING')
  const manifest = Object.fromEntries(Object.keys(BASE_HASHES).map((path) => [path, fileHash(root, path)]))
  for (const [path, expected] of Object.entries(BASE_HASHES))
    if (manifest[path].sha256 !== expected) fail(`BASELINE_${path.replaceAll('.', '_').toUpperCase()}_MISMATCH`)
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  const locked = lock.packages?.['node_modules/katex']
  if (
    !locked ||
    locked.version !== OLD_KATEX.version ||
    locked.resolved !== OLD_KATEX.resolved ||
    locked.integrity !== OLD_KATEX.integrity
  )
    fail('OLD_LOCK_IDENTITY')
  for (const [path, expected] of Object.entries(FROZEN_RENDERER_PACKAGES)) {
    const record = lock.packages?.[path]
    if (!record || record.version !== expected.version || record.integrity !== expected.integrity)
      fail(`FROZEN_${path.replaceAll('/', '_').toUpperCase()}`)
  }
  const installedPath = realpathSync(resolve(root, 'node_modules/katex'))
  const installed = JSON.parse(readFileSync(resolve(installedPath, 'package.json'), 'utf8'))
  if (installed.version !== OLD_KATEX.version) fail('OLD_INSTALLED_IDENTITY')
  const installedStat = statSync(resolve(installedPath, 'package.json'))
  const residue = VULNERABLE_RESIDUE.map((path) => ({ path, ...fileHash(root, path) }))
  const testExit = Number(args.get('test-exit'))
  if (!Number.isInteger(testExit) || testExit < 0 || testExit > 255) fail('TEST_EXIT_CODE')
  const logPath = resolve(root, args.get('log'))
  const logStat = statSync(logPath)
  if (logStat.size > 4 * 1024 * 1024) fail('VITEST_LOG_SIZE')
  const logBytes = readFileSync(logPath)
  if (logBytes.byteLength > 4 * 1024 * 1024) fail('VITEST_LOG_SIZE')
  const logText = logBytes.toString('utf8')
  if (!Buffer.from(logText, 'utf8').equals(logBytes)) fail('VITEST_LOG_UTF8')
  const rawBlocks = parseRawFailureSection(logText)
  const tests = checkReport(resolve(root, args.get('report')), testExit, rawBlocks)
  const runErrorsPath = resolve(root, args.get('run-errors'))
  const outPath = resolve(root, args.get('out'))
  const runErrors = checkRunErrors(runErrorsPath, resolve(dirname(outPath), 'vitest-run-errors.json'))
  if (process.version !== 'v22.22.3' || process.env.NPM_VERSION !== '10.9.8') fail('TOOLCHAIN_PIN')
  const origins = checkHarnessOrigins(dirname(resolve(root, args.get('out'))))
  const result = {
    schema: 1,
    evidence: 'EXPECTED_BASELINE_RED_ONLY',
    securityQualification: false,
    source: {
      commit: process.env.GITHUB_SHA || null,
      baseline: BASE,
      originalHarnessBaseline: HARNESS_BASELINE,
      reviewedImagePolicyCommit: IMAGE_POLICY_COMMIT,
      productionUnchangedReplayOfDependencyBaseline: false,
      lineage,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runnerOs: process.env.RUNNER_OS || process.platform
    },
    toolchain: {
      node: process.version,
      npm: process.env.NPM_VERSION,
      browser: 'installed Playwright Chromium from frozen lockfile',
      vitestJsonReporter: '4.1.11 JsonTestResults'
    },
    baselineManifest: manifest,
    installedOldKaTeX: {
      ...OLD_KATEX,
      realpath: installedPath,
      packageJsonBytes: installedStat.size,
      packageJsonSha256: fileHash(installedPath, 'package.json').sha256
    },
    browserOrigins: origins,
    knownVulnerableInputs: {
      advisory: 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923',
      mermaidVersion: lock.packages?.['node_modules/mermaid']?.version || null,
      alternateBundledKaTeX: residue,
      status: 'installed-package-residue-is-known; shipping-bundle-not-measured-in-this-RED-stage'
    },
    testExitCode: testExit,
    testReport: {
      bytes: statSync(resolve(root, args.get('report'))).size,
      sha256: sha256(readFileSync(resolve(root, args.get('report'))))
    },
    testLog: { bytes: logBytes.byteLength, sha256: sha256(logBytes) },
    unhandledErrors: runErrors,
    tests
  }
  const out = outPath
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log('renderer-katex-provenance:EXPECTED_BASELINE_RED_ONLY')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'renderer-katex-provenance:UNKNOWN')
    process.exitCode = 1
  }
}
