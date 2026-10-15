#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE = '15fcfa376feda44531596218a3751c6ea37f98ef'
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
    values.get('mode') !== 'baseline-red' ||
    !values.get('report') ||
    !values.get('log') ||
    !values.get('run-errors') ||
    !values.get('out') ||
    !values.has('test-exit')
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
function checkHarnessOrigins(directory) {
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
    if (value.katexVersion !== OLD_KATEX.version || !/^\d+\.\d+\.\d+\.\d+(?:-.*)?$/u.test(value.browserVersion || ''))
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
function checkRunErrors(reportPath, expectedPath) {
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
    report.fileCount !== FILES.length ||
    !Number.isInteger(report.errorCount) ||
    report.errorCount !== 0 ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    report.omittedErrors !== 0
  )
    fail('UNHANDLED_ERRORS_PRESENT_OR_RUN_MISMATCH')
  return { bytes: stat.size, sha256: sha256(readFileSync(reportPath)), errorCount: report.errorCount, errorCodes: [] }
}
function main() {
  checkCausalParserFixtures()
  const args = parseArgs(process.argv.slice(2))
  const root = process.cwd()
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
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'renderer-katex-provenance:UNKNOWN')
    process.exitCode = 1
  }
}
