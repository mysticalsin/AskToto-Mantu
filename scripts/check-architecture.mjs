#!/usr/bin/env node
/**
 * Architecture fitness ratchet for module boundaries, dead code, file size and high-risk APIs.
 *
 * This is a ratchet, not a zero-debt gate, because the repository already has large architecture debt.
 * A gate that blocks ordinary churn on all existing debt gets bypassed or switched off; a ratchet keeps
 * new work from adding debt while letting local cleanups shrink the baseline.
 *
 * Falling counts fail too. Once a violation is fixed, the lowered count must be committed so the old
 * allowance cannot become room for a new violation elsewhere.
 *
 * To update scripts/architecture-baseline.json: when counts fall, paste the lowered JSON printed by the
 * failure. When counts rise, edit the baseline only after review, such as for a pure move that relocates
 * existing violations. With no baseline yet, CI prints the seed JSON to commit.
 *
 * FF-15 is a per-file flag (1 for each production module directly under src/main or src/renderer/src/lib), so
 * the top-level module count is the sum of the FF-15 entries in the baseline. It can only fall (a moved file's
 * entry must be deleted) and a new top-level file has no entry, so it fails.
 *
 * Each group below moves as its own pure-move PR that scripts/refactor/verify-move.mjs passes: move the files
 * with their tests, rewrite only import specifiers, delete the moved files' FF-15 entries (and re-home their
 * FF-07 / FF-05 entries), then push and read the CI run. The moves are not applied here because they cannot be
 * verified without running the suite, which runs only in CI.
 * LEAD_ACTION: move src/main/operator-* (incl. operator-skill-*, operator-test-keypair) to src/main/features/operator/
 * LEAD_ACTION: move src/main/dust-* and dustcli* to src/main/features/dust/
 * LEAD_ACTION: move src/main/speaker-* to src/main/features/speaker/
 * LEAD_ACTION: move src/main/asr-* to src/main/features/asr/
 * LEAD_ACTION: move src/main/parakeet* to src/main/features/parakeet/
 * LEAD_ACTION: move src/main/license*.ts plus src/main/license/ (incl. license-lease-key.ts) to src/main/features/license/
 * LEAD_ACTION: move src/renderer/src/lib/onboarding-*.ts and onboarding-*.test.ts to src/renderer/src/features/onboarding/, keeping FF-01 at 0 production violations
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/** @typedef {Record<string, Record<string, number>>} Counts */
/** @typedef {{ rule: string, file: string, baseline: number, current: number }} Difference */
/** @typedef {{ rule: { name: string }, from: string }} DependencyViolation */
/** @typedef {{ named: Map<string, string>, namespaces: Set<string> }} FsBindings */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(repoRoot, 'scripts', 'architecture-baseline.json')
const TEST_FILE = /\.(test|spec)\.tsx?$/
const TS_FILE = /\.tsx?$/
const D_TS_FILE = /\.d\.ts$/
const PATH_LIKE_TS = /^[^\s]*\.tsx?$/
const DIALOG_NAMES = new Set(['confirm', 'alert', 'prompt'])
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'])
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const MEETINGS_ROOT_READERS = new Set([
  'src/main/brain/ingest.ts',
  'src/main/brain/publish.ts',
  'src/main/brain/store.ts',
  'src/main/graphify.ts',
  'src/main/recall.ts',
  'src/main/transcripts.ts',
])

const RULES = [
  ['FF-01', 'Imports across a layer boundary'],
  ['FF-02', 'Imports on a cycle'],
  ['FF-03', 'Modules no entry point reaches'],
  ['FF-04', 'Lines in source files longer than 800 lines'],
  ['FF-05a', 'Synchronous fs calls in the main process'],
  ['FF-05b', 'fs calls in meetings-root modules outside the storage gateway'],
  ['FF-06', 'Native confirm/alert/prompt in renderer code'],
  ['FF-07', 'TypeScript source paths named by tests that read files'],
  ['FF-09', 'ipcMain registrations outside src/main/ipc/'],
  ['FF-10', 'Process spawning outside src/main/infra/process/'],
  ['FF-11', 'BrowserWindow construction outside src/main/windows/'],
  ['FF-14', 'Background timers outside src/main/infra/scheduler/'],
  ['FF-15', 'Production modules directly under src/main or src/renderer/src/lib'],
]

// `.tsx` is included on purpose: a top-level component or hook is as much a flat module as a `.ts` helper.
const TOP_LEVEL_MODULE = /^(src\/main|src\/renderer\/src\/lib)\/[^/]+\.tsx?$/

const RULE_IDS = RULES.map(([id]) => id)
const RULE_TITLES = new Map(RULES)

/**
 * Counts architecture source-detector violations for one file.
 * @param {string} file Repository-relative POSIX path.
 * @param {string} text Source text.
 * @returns {Record<string, number>} Non-zero counts keyed by rule id.
 */
export function countSourceFile(file, text) {
  const normalized = text.replace(/\r\n/g, '\n')
  const sourceFile = ts.createSourceFile(
    file,
    normalized,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const counts = {}
  const add = (rule, count = 1) => {
    if (count > 0) counts[rule] = (counts[rule] ?? 0) + count
  }

  if (isProductionFile(file) && file.startsWith('src/')) {
    const lines = countLines(normalized)
    if (lines > 800) add('FF-04', lines)
  }

  const fsBindings = collectFsBindings(sourceFile)
  if (isProductionFile(file) && file.startsWith('src/main/')) {
    add('FF-05a', countFsCalls(sourceFile, fsBindings, true))
  }
  if (isProductionFile(file) && MEETINGS_ROOT_READERS.has(file)) {
    add('FF-05b', countFsCalls(sourceFile, fsBindings, false))
  }
  if (isProductionFile(file) && (file.startsWith('src/renderer/') || file.startsWith('intelligence/src/'))) {
    add('FF-06', countNativeDialogs(sourceFile))
  }
  if (
    TEST_FILE.test(file) &&
    (file.startsWith('src/') || file.startsWith('scripts/') || file.startsWith('intelligence/src/')) &&
    hasQualifyingFsReadBinding(fsBindings)
  ) {
    add('FF-07', countSourcePathLiterals(sourceFile))
  }
  if (isProductionFile(file) && file.startsWith('src/') && !file.startsWith('src/main/ipc/')) {
    add('FF-09', countIpcMainRegistrations(sourceFile))
  }
  if (isProductionFile(file) && file.startsWith('src/') && !file.startsWith('src/main/infra/process/')) {
    add('FF-10', countProcessSpawning(sourceFile))
  }
  if (isProductionFile(file) && file.startsWith('src/') && !file.startsWith('src/main/windows/')) {
    add('FF-11', countBrowserWindowConstruction(sourceFile))
  }
  if (isProductionFile(file) && file.startsWith('src/main/') && !file.startsWith('src/main/infra/scheduler/')) {
    add('FF-14', countBackgroundTimers(sourceFile))
  }

  return counts
}

/**
 * Counts a production module that sits directly under src/main or src/renderer/src/lib instead of a
 * feature folder. Each such file is one entry in the baseline, so a new top-level file rises from 0 to 1
 * and fails, while moving one into a folder falls to 0 and must be committed.
 * @param {string} file Repository-relative POSIX path.
 * @returns {number} 1 for a top-level production module, otherwise 0.
 */
export function countTopLevelModule(file) {
  return isProductionFile(file) && TOP_LEVEL_MODULE.test(file) ? 1 : 0
}

/**
 * Counts dependency-cruiser violations by fitness-function id and source file.
 * @param {DependencyViolation[]} violations dependency-cruiser summary violations.
 * @returns {Counts} Counts keyed by rule id and file.
 */
export function countDependencyViolations(violations) {
  /** @type {Counts} */
  const counts = {}
  for (const violation of violations) {
    const match = violation.rule.name.match(/^ff(\d{2}[ab]?)-/)
    if (!match) throw new Error(`Dependency-cruiser rule lacks ffNN prefix: ${violation.rule.name}`)
    const rule = `FF-${match[1]}`
    if (!['FF-01', 'FF-02', 'FF-03'].includes(rule)) {
      throw new Error(`Dependency-cruiser rule reports non-module fitness function ${rule}: ${violation.rule.name}`)
    }
    counts[rule] ??= {}
    counts[rule][violation.from] = (counts[rule][violation.from] ?? 0) + 1
  }
  return counts
}

/**
 * Compares baseline and current counts.
 * @param {Counts} baseline Accepted counts.
 * @param {Counts} current Current counts.
 * @returns {{ regressions: Difference[], stale: Difference[] }} Differences in sorted rule/file order.
 */
export function compareCounts(baseline, current) {
  /** @type {Difference[]} */
  const regressions = []
  /** @type {Difference[]} */
  const stale = []
  for (const rule of RULE_IDS) {
    const files = new Set([...Object.keys(baseline[rule] ?? {}), ...Object.keys(current[rule] ?? {})])
    for (const file of [...files].sort()) {
      const baselineCount = baseline[rule]?.[file] ?? 0
      const currentCount = current[rule]?.[file] ?? 0
      if (currentCount > baselineCount) {
        regressions.push({ rule, file, baseline: baselineCount, current: currentCount })
      } else if (currentCount < baselineCount) {
        stale.push({ rule, file, baseline: baselineCount, current: currentCount })
      }
    }
  }
  return { regressions, stale }
}

/**
 * Returns a baseline with existing entries lowered to current counts, never raised or added.
 * @param {Counts} baseline Accepted counts.
 * @param {Counts} current Current counts.
 * @returns {Counts} Lowered counts.
 */
export function lowerBaseline(baseline, current) {
  /** @type {Counts} */
  const lowered = {}
  for (const rule of RULE_IDS) {
    for (const [file, baselineCount] of Object.entries(baseline[rule] ?? {})) {
      const currentCount = current[rule]?.[file] ?? 0
      const value = Math.min(baselineCount, currentCount)
      if (Number.isInteger(value) && value > 0) {
        lowered[rule] ??= {}
        lowered[rule][file] = value
      }
    }
  }
  /** @type {Counts} */
  const sorted = {}
  for (const rule of RULE_IDS) {
    const files = Object.keys(lowered[rule] ?? {}).sort()
    if (files.length === 0) continue
    sorted[rule] = {}
    for (const file of files) sorted[rule][file] = lowered[rule][file]
  }
  return sorted
}

/**
 * Formats counts as canonical baseline JSON.
 * @param {Counts} counts Counts to format.
 * @returns {string} Canonical JSON with trailing newline.
 */
export function formatBaseline(counts) {
  return `${JSON.stringify(canonicalCounts(counts), null, 2)}\n`
}

/**
 * @param {Counts} counts Counts to canonicalize.
 * @returns {Counts} Counts in fixed rule order with sorted positive integer entries.
 */
function canonicalCounts(counts) {
  /** @type {Counts} */
  const canonical = {}
  for (const rule of RULE_IDS) {
    canonical[rule] = {}
    for (const file of Object.keys(counts[rule] ?? {}).sort()) {
      const value = counts[rule][file]
      if (Number.isInteger(value) && value > 0) canonical[rule][file] = value
    }
  }
  return canonical
}

/**
 * @param {string} file Repository-relative POSIX path.
 * @returns {boolean} Whether the file is production TypeScript.
 */
function isProductionFile(file) {
  return TS_FILE.test(file) && !TEST_FILE.test(file) && !D_TS_FILE.test(file) && !file.includes('/__fixtures__/')
}

/**
 * @param {string} text Normalized source text.
 * @returns {number} Logical line count.
 */
function countLines(text) {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {FsBindings} fs bindings.
 */
function collectFsBindings(sourceFile) {
  /** @type {FsBindings} */
  const bindings = { named: new Map(), namespaces: new Set() }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && FS_MODULES.has(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause && !clause.isTypeOnly) {
        if (clause.name) bindings.namespaces.add(clause.name.text)
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.namespaces.add(clause.namedBindings.name.text)
          } else {
            for (const specifier of clause.namedBindings.elements) {
              if (!specifier.isTypeOnly) {
                const imported = (specifier.propertyName ?? specifier.name).text
                if (imported === 'promises') {
                  bindings.namespaces.add(specifier.name.text)
                } else {
                  bindings.named.set(specifier.name.text, imported)
                }
              }
            }
          }
        }
      }
    }
    const initializer = unwrapExpression(node.initializer)
    if (isRequireCall(initializer) && FS_MODULES.has(initializer.arguments[0].text)) {
      collectFsRequireBinding(node.name, bindings)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return bindings
}

/**
 * @param {ts.Node | undefined} node Candidate expression.
 * @returns {ts.Node | undefined} Expression without transparent wrappers.
 */
function unwrapExpression(node) {
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) {
    node = node.expression
  }
  return node
}

/**
 * @param {ts.Node} node Candidate variable initializer.
 * @returns {node is ts.CallExpression & { arguments: ts.NodeArray<ts.StringLiteral> }} Whether it is require('...').
 */
function isRequireCall(node) {
  return Boolean(
    node &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
  )
}

/**
 * @param {ts.BindingName} name Binding pattern.
 * @param {FsBindings} bindings Bindings to update.
 * @returns {void}
 */
function collectFsRequireBinding(name, bindings) {
  if (ts.isIdentifier(name)) {
    bindings.namespaces.add(name.text)
    return
  }
  if (!ts.isObjectBindingPattern(name)) return
  for (const element of name.elements) {
    if (ts.isIdentifier(element.name)) {
      const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
      if (imported === 'promises') {
        bindings.namespaces.add(element.name.text)
      } else {
        bindings.named.set(element.name.text, imported)
      }
    }
  }
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @param {FsBindings} bindings fs bindings.
 * @param {boolean} syncOnly Whether to count only sync calls.
 * @returns {number} Number of fs calls.
 */
function countFsCalls(sourceFile, bindings, syncOnly) {
  let count = 0
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = fsCallName(node.expression, bindings)
      if (name && (!syncOnly || name.endsWith('Sync'))) count += 1
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.Expression} expression Call expression callee.
 * @param {FsBindings} bindings fs bindings.
 * @returns {string | undefined} Bound fs member name.
 */
function fsCallName(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text)
  const chain = propertyChain(expression)
  if (chain.length >= 2 && bindings.namespaces.has(chain[0])) return chain[chain.length - 1]
  return undefined
}

/**
 * @param {ts.Node} node Node to flatten.
 * @returns {string[]} Dotted identifier/property chain.
 */
function propertyChain(node) {
  if (ts.isIdentifier(node)) return [node.text]
  if (ts.isThis(node)) return ['this']
  if (ts.isPropertyAccessExpression(node)) return [...propertyChain(node.expression), node.name.text]
  return []
}

/**
 * @param {FsBindings} bindings fs bindings.
 * @returns {boolean} Whether the file has a qualifying fs read binding.
 */
function hasQualifyingFsReadBinding(bindings) {
  if (bindings.namespaces.size > 0) return true
  return [...bindings.named.values()].some((name) => name === 'readFileSync' || name === 'readFile')
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {Set<string>} Locally declared names.
 */
function collectLocalNames(sourceFile) {
  const names = new Set()
  const addBindingName = (name) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text)
    } else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingName(element.name)
      }
    }
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) addBindingName(node.name)
    if (ts.isParameter(node)) addBindingName(node.name)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text)
    if (ts.isImportClause(node) && node.name) names.add(node.name.text)
    if (ts.isImportSpecifier(node)) names.add(node.name.text)
    if (ts.isNamespaceImport(node)) names.add(node.name.text)
    if (ts.isBindingElement(node)) addBindingName(node.name)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return names
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {number} Native dialog accesses.
 */
function countNativeDialogs(sourceFile) {
  const localNames = collectLocalNames(sourceFile)
  let count = 0
  const visit = (node) => {
    const destructuredDialogs = countNativeDialogDestructure(node)
    if (isNativeDialogPropertyAccess(node) || isNativeDialogElementAccess(node)) {
      count += 1
    } else if (destructuredDialogs > 0) {
      count += destructuredDialogs
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && DIALOG_NAMES.has(node.expression.text) && !localNames.has(node.expression.text)) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.Node} node Candidate node.
 * @returns {boolean} Whether it is window/globalThis/self.confirm-style access.
 */
function isNativeDialogPropertyAccess(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    DIALOG_NAMES.has(node.name.text) &&
    ts.isIdentifier(node.expression) &&
    ['window', 'globalThis', 'self'].includes(node.expression.text)
  )
}

/**
 * @param {ts.Node} node Candidate node.
 * @returns {boolean} Whether it is window/globalThis/self['confirm']-style access.
 */
function isNativeDialogElementAccess(node) {
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ['window', 'globalThis', 'self'].includes(node.expression.text) &&
    ts.isStringLiteral(node.argumentExpression) &&
    DIALOG_NAMES.has(node.argumentExpression.text)
  )
}

/**
 * @param {ts.Node} node Candidate node.
 * @returns {number} Number of native dialogs destructured from a global object.
 */
function countNativeDialogDestructure(node) {
  if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return 0
  if (!node.initializer || !ts.isIdentifier(node.initializer) || !['window', 'globalThis', 'self'].includes(node.initializer.text)) return 0
  return node.name.elements.filter((element) => {
    const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined
    const name = ts.isIdentifier(element.name) ? element.name.text : undefined
    return DIALOG_NAMES.has(property ?? name ?? '')
  }).length
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {number} Source-looking path literals.
 */
function countSourcePathLiterals(sourceFile) {
  let count = 0
  const visit = (node) => {
    count += sourcePathLiteralCount(node)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.Node} node Candidate node.
 * @returns {number} Number of source-looking path literals.
 */
function sourcePathLiteralCount(node) {
  const value = literalText(node)
  if (isSourcePathLiteral(value)) return 1
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.filter((span) => isSourcePathLiteral(span.literal.text)).length
  }
  return 0
}

/**
 * @param {string | undefined} value Literal text.
 * @returns {boolean} Whether the literal names a source path counted by FF-07.
 */
function isSourcePathLiteral(value) {
  return Boolean(value && PATH_LIKE_TS.test(value) && !value.endsWith('.d.ts') && !value.includes('__fixtures__'))
}

/**
 * @param {ts.Node} node Candidate node.
 * @returns {string | undefined} Literal text.
 */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {number} ipcMain registrations.
 */
function countIpcMainRegistrations(sourceFile) {
  const methods = new Set(['handle', 'handleOnce', 'on', 'once', 'addListener'])
  let count = 0
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const chain = propertyChain(node.expression)
      if (
        (chain.length === 2 && chain[0] === 'ipcMain' && methods.has(chain[1])) ||
        (chain.length === 3 && chain[1] === 'ipcMain' && methods.has(chain[2]))
      ) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {number} Process spawning violations.
 */
function countProcessSpawning(sourceFile) {
  let count = 0
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      if (node.importClause && !node.importClause.isTypeOnly && !hasOnlyTypeNamedImports(node.importClause)) count += 1
    }
    if (isRequireCall(node) && CHILD_PROCESS_MODULES.has(node.arguments[0].text)) count += 1
    if (ts.isPropertyAccessExpression(node)) {
      const chain = propertyChain(node)
      if (chain.length >= 2 && chain[chain.length - 2] === 'utilityProcess' && chain[chain.length - 1] === 'fork') {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.ImportClause} clause Import clause to inspect.
 * @returns {boolean} Whether the clause has only inline type named imports.
 */
function hasOnlyTypeNamedImports(clause) {
  return Boolean(
    !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((specifier) => specifier.isTypeOnly)
  )
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {number} BrowserWindow constructions.
 */
function countBrowserWindowConstruction(sourceFile) {
  let count = 0
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const chain = propertyChain(node.expression)
      if ((chain.length === 1 && chain[0] === 'BrowserWindow') || (chain.length === 2 && chain[1] === 'BrowserWindow')) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.SourceFile} sourceFile Parsed source file.
 * @returns {number} Background timer violations.
 */
function countBackgroundTimers(sourceFile) {
  let count = 0
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const chain = propertyChain(node.expression)
      const callee = chain[chain.length - 1]
      if (callee === 'setInterval') {
        count += 1
      } else if (callee === 'setTimeout' && timeoutRearmsEnclosingFunction(node)) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return count
}

/**
 * @param {ts.CallExpression} node setTimeout call.
 * @returns {boolean} Whether it re-arms an enclosing function-like ancestor.
 */
function timeoutRearmsEnclosingFunction(node) {
  const names = enclosingFunctionNames(node)
  if (names.size === 0) return false
  const first = node.arguments[0]
  if (!first) return false
  if (ts.isIdentifier(first) && names.has(first.text)) return true
  let found = false
  const visit = (child) => {
    if (found) return
    if (ts.isCallExpression(child)) {
      if (ts.isIdentifier(child.expression) && names.has(child.expression.text)) found = true
      if (ts.isPropertyAccessExpression(child.expression) && ts.isThis(child.expression.expression) && names.has(child.expression.name.text)) found = true
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(first, visit)
  return found
}

/**
 * @param {ts.Node} node Node inside a function-like.
 * @returns {Set<string>} Names of enclosing function-like declarations.
 */
function enclosingFunctionNames(node) {
  const names = new Set()
  let current = node.parent
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.name) names.add(current.name.text)
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) names.add(parent.name.text)
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) names.add(parent.name.text)
      if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) names.add(parent.name.text)
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) names.add(current.name.text)
    current = current.parent
  }
  return names
}

/**
 * @returns {string[]} Repository-relative POSIX TypeScript paths to scan.
 */
function walkSourceFiles() {
  const roots = ['src', 'scripts', 'intelligence/src']
  /** @type {string[]} */
  const files = []
  for (const root of roots) {
    const absoluteRoot = join(repoRoot, root)
    if (!existsSync(absoluteRoot)) throw new Error(`Architecture scan root does not exist: ${root}`)
    walkDirectory(absoluteRoot, files)
  }
  return files.sort()
}

/**
 * @param {string} directory Absolute directory.
 * @param {string[]} files Accumulator.
 * @returns {void}
 */
function walkDirectory(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walkDirectory(absolute, files)
    } else if (entry.isFile() && TS_FILE.test(entry.name)) {
      files.push(relative(repoRoot, absolute).split(sep).join('/'))
    }
  }
}

/**
 * @param {Counts} target Counts to mutate.
 * @param {Counts} addition Counts to add.
 * @returns {void}
 */
function mergeCounts(target, addition) {
  for (const [rule, files] of Object.entries(addition)) {
    target[rule] ??= {}
    for (const [file, count] of Object.entries(files)) {
      target[rule][file] = (target[rule][file] ?? 0) + count
    }
  }
}

/**
 * @returns {Counts} Current architecture counts.
 */
function collectCurrentCounts() {
  /** @type {Counts} */
  const current = {}
  for (const file of walkSourceFiles()) {
    const text = readFileSync(join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n')
    // Copy so adding FF-15 does not mutate the object countSourceFile returned.
    const fileCounts = { ...countSourceFile(file, text) }
    if (countTopLevelModule(file) > 0) fileCounts['FF-15'] = 1
    for (const [rule, count] of Object.entries(fileCounts)) {
      current[rule] ??= {}
      current[rule][file] = count
    }
  }
  mergeCounts(current, runDependencyCruiser())
  return canonicalCounts(current)
}

/**
 * @returns {Counts} dependency-cruiser violation counts.
 */
function runDependencyCruiser() {
  const stdout = execFileSync(process.execPath, [
    join(repoRoot, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs'),
    'src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json', '--no-progress',
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const report = JSON.parse(stdout)
  return countDependencyViolations(report.summary.violations)
}

/**
 * @param {Counts} counts Counts to summarize.
 * @returns {void}
 */
function printSummary(counts) {
  for (const [rule, title] of RULES) {
    const values = Object.values(counts[rule] ?? {})
    const total = values.reduce((sum, count) => sum + count, 0)
    console.log(`[check:architecture] ${rule.padEnd(8)}${String(total).padStart(4)} in ${values.length} files: ${title}`)
  }
}

/**
 * @returns {{ ok: true, baseline: Counts } | { ok: false }} Baseline read result.
 */
function readBaseline() {
  const text = readFileSync(BASELINE_PATH, 'utf8').replace(/\r\n/g, '\n')
  let parsed, canonical
  try {
    parsed = JSON.parse(text)
    canonical = formatBaseline(parsed)
  } catch (error) {
    console.log(`[check:architecture] FAIL: scripts/architecture-baseline.json is not canonical; ${error.message}`)
    process.exitCode = 1
    return { ok: false }
  }
  if (canonical !== text) {
    console.log('[check:architecture] FAIL: scripts/architecture-baseline.json is not canonical; use the rendering below.')
    console.log(canonical)
    process.exitCode = 1
    return { ok: false }
  }
  return { ok: true, baseline: canonicalCounts(parsed) }
}

/**
 * Runs the architecture ratchet CLI.
 * @returns {void}
 */
function main() {
  /** @type {Counts} */
  let current
  try {
    current = collectCurrentCounts()
  } catch (error) {
    if (error?.stderr) process.stderr.write(error.stderr)
    throw error
  }

  printSummary(current)

  if (!existsSync(BASELINE_PATH)) {
    console.log('[check:architecture] FAIL: scripts/architecture-baseline.json does not exist. Commit the counts below as that file:')
    console.log(formatBaseline(current))
    process.exitCode = 1
    return
  }

  const baselineResult = readBaseline()
  if (!baselineResult.ok) return

  const { regressions, stale } = compareCounts(baselineResult.baseline, current)
  const differenceCount = regressions.length + stale.length
  if (differenceCount > 0) {
    console.log(`[check:architecture] FAIL: ${differenceCount} counts differ from scripts/architecture-baseline.json`)
    for (const difference of regressions) {
      console.log(`  ${difference.rule} ${difference.file}: ${difference.baseline} -> ${difference.current} (rose; counts may only fall)`)
    }
    for (const difference of stale) {
      console.log(`  ${difference.rule} ${difference.file}: ${difference.baseline} -> ${difference.current} (fell; lower the baseline)`)
    }
    if (regressions.length > 0) {
      console.log('A count rises only through a reviewed edit of the baseline, for example a pure move that relocates existing violations.')
    }
    if (stale.length > 0) {
      console.log('Baseline with every fallen count lowered (raises nothing):')
      console.log(formatBaseline(lowerBaseline(baselineResult.baseline, current)))
    }
    process.exitCode = 1
    return
  }

  console.log('[check:architecture] OK: every count matches scripts/architecture-baseline.json.')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    console.error(`[check:architecture] FAIL: ${error.message}`)
    process.exitCode = 1
  }
}
