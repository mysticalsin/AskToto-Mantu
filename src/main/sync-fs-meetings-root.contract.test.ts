/**
 * Guard the meetings-root reader migration against new synchronous node:fs calls.
 *
 * The surviving baseline is intentionally per-file: a later, separate pass narrows the nonzero entries
 * file by file, and this ratchet refuses both new sync call sites and stale baselines after removals.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const syncNames = [
  'accessSync',
  'appendFileSync',
  'chmodSync',
  'chownSync',
  'closeSync',
  'copyFileSync',
  'cpSync',
  'existsSync',
  'fchmodSync',
  'fchownSync',
  'fdatasyncSync',
  'fstatSync',
  'fsyncSync',
  'ftruncateSync',
  'futimesSync',
  'lchmodSync',
  'lchownSync',
  'linkSync',
  'lstatSync',
  'lutimesSync',
  'mkdirSync',
  'mkdtempSync',
  'openSync',
  'opendirSync',
  'readFileSync',
  'readdirSync',
  'readlinkSync',
  'readSync',
  'readvSync',
  'realpathSync',
  'renameSync',
  'rmSync',
  'rmdirSync',
  'statSync',
  'symlinkSync',
  'truncateSync',
  'unlinkSync',
  'utimesSync',
  'writeFileSync',
  'writeSync',
  'writevSync'
] as const

const syncNameSet = new Set<string>(syncNames)

const FILES = [
  'transcripts.ts',
  'brain/ledger.ts',
  'brain/ingest.ts',
  'brain/inputs.ts',
  'brain/status.ts',
  'brain/consolidate.ts',
  'brain/intelligence-index.ts',
  'brain/intelligence-work.ts',
  'brain/intelligence-pass.ts',
  'brain/corrections.ts',
  'brain/match-key-cache.ts',
  'brain/store.ts',
  'recall.ts'
] as const

type TargetFile = typeof FILES[number]

/**
 * Accepted sync node:fs call sites as of the M2-0031 gateway migration seed.
 * Only ever revise an entry DOWNWARD when that file is migrated further; never raise it.
 */
const BASELINE: Record<TargetFile, number> = {
  'transcripts.ts': 24,
  'brain/ledger.ts': 0,
  'brain/ingest.ts': 0,
  'brain/inputs.ts': 0,
  'brain/status.ts': 0,
  'brain/consolidate.ts': 0,
  'brain/intelligence-index.ts': 0,
  'brain/intelligence-work.ts': 0,
  'brain/intelligence-pass.ts': 0,
  'brain/corrections.ts': 10,
  'brain/match-key-cache.ts': 4,
  'brain/store.ts': 28,
  'recall.ts': 0
}

const GATEWAY_MIGRATED_ZERO_FILES = [
  'brain/ledger.ts',
  'brain/ingest.ts',
  'brain/inputs.ts',
  'brain/status.ts'
] as const satisfies readonly TargetFile[]

interface SyncFsCall {
  importedName: string
  line: number
  text: string
}

function collectSyncFsCalls(file: string, text: string): SyncFsCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const importedSyncNames = new Map<string, string>()
  const namespaceImports = new Set<string>()
  const calls: SyncFsCall[] = []
  const scopeStack: Array<Set<string>> = [new Set()]

  const isNodeFsImport = (node: ts.ImportDeclaration): boolean =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:fs'

  const declareShadow = (name: string): void => {
    if (importedSyncNames.has(name) || namespaceImports.has(name)) scopeStack[scopeStack.length - 1].add(name)
  }
  const isShadowed = (name: string): boolean => scopeStack.some((scope) => scope.has(name))
  const declareBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      declareShadow(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) declareBindingName(element.name)
    }
  }
  const withScope = (fn: () => void): void => {
    scopeStack.push(new Set())
    try {
      fn()
    } finally {
      scopeStack.pop()
    }
  }
  const record = (node: ts.CallExpression, importedName: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.expression.getStart(source))
    calls.push({ importedName, line: line + 1, text: node.expression.getText(source) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings
      if (isNodeFsImport(node)) {
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text
            if (syncNameSet.has(importedName)) importedSyncNames.set(element.name.text, importedName)
          }
        } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          namespaceImports.add(namedBindings.name.text)
        }
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) declareShadow(element.name.text)
      } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        declareShadow(namedBindings.name.text)
      }
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name) declareShadow(node.name.text)
    if (ts.isFunctionLike(node)) {
      withScope(() => {
        for (const param of node.parameters) declareBindingName(param.name)
        ts.forEachChild(node, (child) => {
          if (!ts.isParameter(child)) visit(child)
        })
      })
      return
    }
    if (ts.isBlock(node)) {
      withScope(() => ts.forEachChild(node, visit))
      return
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const importedName = importedSyncNames.get(node.expression.text)
        if (importedName && !isShadowed(node.expression.text)) record(node, importedName)
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression
        if (
          ts.isIdentifier(receiver) &&
          namespaceImports.has(receiver.text) &&
          !isShadowed(receiver.text) &&
          syncNameSet.has(node.expression.name.text)
        ) {
          record(node, node.expression.name.text)
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      ts.forEachChild(node, visit)
      declareBindingName(node.name)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

function readCalls(file: TargetFile): SyncFsCall[] {
  return collectSyncFsCalls(file, readFileSync(join(__dirname, file), 'utf8'))
}

function callList(calls: readonly SyncFsCall[]): string {
  return calls.map((call) => `line ${call.line}: ${call.text} (${call.importedName})`).join('\n')
}

describe('meetings-root readers — synchronous node:fs structural ratchet', () => {
  it('counts only real CallExpression nodes imported from node:fs', () => {
    const calls = collectSyncFsCalls('synthetic.ts', `
      import { readFileSync, statSync as statNow } from 'node:fs'
      import * as fs from 'node:fs'
      import { readFileSync as readPromiseNamedSame } from 'node:fs/promises'

      const readFileSync = () => undefined
      const text = 'readFileSync("comment-shaped string")'
      // statSync('/not-real')
      readFileSync()
      statNow('/tmp/a')
      fs.readdirSync('/tmp')
      readPromiseNamedSame('/tmp/b')
    `)

    expect(calls.map((call) => call.importedName)).toEqual(['statSync', 'readdirSync'])
  })

  it('matches the checked-in per-file sync node:fs baseline exactly', () => {
    for (const file of FILES) {
      const calls = readCalls(file)
      const count = calls.length
      const baseline = BASELINE[file]
      if (count > baseline) {
        expect.fail(
          `${file}: ${count} sync node:fs call sites, up from the ${baseline} baseline.\n` +
          'Remove the new main-thread sync fs call; do NOT raise the baseline.\n' +
          callList(calls)
        )
      }
      if (count < baseline) {
        expect.fail(
          `${file}: ${count} sync node:fs call sites, BELOW the ${baseline} baseline. Good news, but ` +
          `the baseline is now stale and would let ${baseline - count} new call sites back in unnoticed. ` +
          `Set BASELINE['${file}'] = ${count}.`
        )
      }
      expect(count, `${file}: sync node:fs baseline`).toBe(baseline)
    }
  })

  it('keeps the already-gateway-migrated meetings-root readers at hard zero', () => {
    for (const file of GATEWAY_MIGRATED_ZERO_FILES) {
      const calls = readCalls(file)
      expect(calls, `${file}: no synchronous node:fs calls after gateway migration`).toEqual([])
    }
  })
})
