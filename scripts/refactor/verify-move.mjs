#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DEFAULT_OUTPUT_DIR = 'out/refactor/verify-move'

export function normalizeImportPaths(source) {
  return source
    .replace(/(\bimport\s*\(\s*)(['"])([^'"]+)(\2\s*\))/g, '$1$2__IMPORT_PATH__$4')
    .replace(/(\bimport\s*)(['"])([^'"]+)(\2)/g, '$1$2__IMPORT_PATH__$4')
    .replace(/(\bexport\s+[\s\S]*?\bfrom\s*)(['"])([^'"]+)(\2)/g, '$1$2__IMPORT_PATH__$4')
    .replace(/(\bimport\s+[\s\S]*?\bfrom\s*)(['"])([^'"]+)(\2)/g, '$1$2__IMPORT_PATH__$4')
    .replace(/(\brequire\s*\(\s*)(['"])([^'"]+)(\2\s*\))/g, '$1$2__IMPORT_PATH__$4')
}

export function tokenMultiset(source) {
  return tokenMultisetFromTokens(normalizedTokenSequence(source))
}

export function normalizedTokenSequence(source) {
  const normalized = stripComments(normalizeImportPaths(source))
  return [...normalized.matchAll(tokenPattern())].map(([token]) => token)
}

function tokenMultisetFromTokens(tokens) {
  const counts = new Map()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

export function compareMultisets(left, right) {
  const problems = []
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort()
  for (const key of keys) {
    const removed = left.get(key) ?? 0
    const added = right.get(key) ?? 0
    if (removed !== added) problems.push({ token: key, removed, added })
  }
  return problems
}

export function parseNameStatus(output) {
  if (output.trim() === '') return []
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const entries = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    const code = status[0]
    if (code === 'R' || code === 'C') {
      entries.push({ status, code, oldPath: fields[index++], newPath: fields[index++] })
    } else {
      entries.push({ status, code, path: fields[index++] })
    }
  }
  return entries
}

export function verifyPureMove({ entries, readAtRevision }) {
  const removed = new Map()
  const added = new Map()
  const removedFiles = []
  const addedFiles = []
  const modifiedProblems = []
  const orderProblems = []
  const unsupported = []

  const addTokens = (target, tokens) => {
    for (const [token, count] of tokenMultisetFromTokens(tokens)) {
      target.set(token, (target.get(token) ?? 0) + count)
    }
  }

  const recordRemoved = (path, source) => {
    const tokens = normalizedTokenSequence(source)
    removedFiles.push({ path, tokens })
    addTokens(removed, tokens)
    return tokens
  }

  const recordAdded = (path, source) => {
    const tokens = normalizedTokenSequence(source)
    addedFiles.push({ path, tokens })
    addTokens(added, tokens)
    return tokens
  }

  for (const entry of entries) {
    if (entry.code === 'A') {
      recordAdded(entry.path, readAtRevision('head', entry.path))
    } else if (entry.code === 'D') {
      recordRemoved(entry.path, readAtRevision('base', entry.path))
    } else if (entry.code === 'R') {
      recordRemoved(entry.oldPath, readAtRevision('base', entry.oldPath))
      recordAdded(entry.newPath, readAtRevision('head', entry.newPath))
    } else if (entry.code === 'M') {
      const before = normalizeImportPaths(readAtRevision('base', entry.path))
      const after = normalizeImportPaths(readAtRevision('head', entry.path))
      if (before !== after) modifiedProblems.push(entry.path)
    } else {
      unsupported.push(entry.status)
    }
  }

  const usedAddedIndexes = new Set()
  for (const removedFile of removedFiles) {
    const exactIndex = addedFiles.findIndex((addedFile, index) => {
      return !usedAddedIndexes.has(index) && sameTokenSequence(removedFile.tokens, addedFile.tokens)
    })
    if (exactIndex >= 0) {
      usedAddedIndexes.add(exactIndex)
      continue
    }

    const reorderedIndex = addedFiles.findIndex((addedFile, index) => {
      return !usedAddedIndexes.has(index) && sameTokenMultiset(removedFile.tokens, addedFile.tokens)
    })
    if (reorderedIndex >= 0) {
      usedAddedIndexes.add(reorderedIndex)
      orderProblems.push({
        removedPath: removedFile.path,
        addedPath: addedFiles[reorderedIndex].path
      })
      continue
    }

    orderProblems.push({
      removedPath: removedFile.path,
      addedPath: null
    })
  }

  const tokenProblems = compareMultisets(removed, added)
  return {
    ok: modifiedProblems.length === 0 && orderProblems.length === 0 && unsupported.length === 0 && tokenProblems.length === 0,
    modifiedProblems,
    orderProblems,
    unsupported,
    tokenProblems
  }
}

function sameTokenSequence(left, right) {
  return left.length === right.length && left.every((token, index) => token === right[index])
}

function sameTokenMultiset(left, right) {
  return compareMultisets(tokenMultisetFromTokens(left), tokenMultisetFromTokens(right)).length === 0
}

function tokenPattern() {
  return /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[{}()[\].,;:?+\-*/%<>=!&|^~]/g
}

function stripComments(source) {
  let output = ''
  let index = 0
  let state = 'code'
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code' && char === '/' && next === '/') {
      state = 'line'
      index += 2
    } else if (state === 'code' && char === '/' && next === '*') {
      state = 'block'
      index += 2
    } else if (state === 'line' && char === '\n') {
      output += char
      state = 'code'
      index += 1
    } else if (state === 'block' && char === '*' && next === '/') {
      state = 'code'
      index += 2
    } else if (state === 'code') {
      output += char
      index += 1
    } else {
      index += 1
    }
  }
  return output
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...options })
}

function usageError(message) {
  console.error(`verify-move: ${message}`)
  console.error('usage: node scripts/refactor/verify-move.mjs --base <rev> --head <rev> [--output-dir <dir>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base') args.base = argv[++index]
    else if (arg === '--head') args.head = argv[++index]
    else if (arg === '--output-dir') args.outputDir = argv[++index]
    else usageError(`unknown argument ${arg}`)
  }
  if (!args.base) usageError('--base is required')
  if (!args.head) usageError('--head is required')
  return args
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const diff = git(['diff', '--name-status', '--find-renames=50%', '-z', args.base, args.head])
  const entries = parseNameStatus(diff)
  const result = verifyPureMove({
    entries,
    readAtRevision: (side, path) => git(['show', `${side === 'base' ? args.base : args.head}:${path}`])
  })
  const outputDir = resolve(repoRoot, args.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const report = {
    schema: 1,
    base: args.base,
    head: args.head,
    ok: result.ok,
    changed_paths: entries.length,
    modified_non_import_paths: result.modifiedProblems,
    token_order_differences: result.orderProblems,
    unsupported_statuses: result.unsupported,
    token_differences: result.tokenProblems.slice(0, 100)
  }
  writeFileSync(join(outputDir, 'verify-move.json'), `${JSON.stringify(report, null, 2)}\n`)

  const displayPath = relative(repoRoot, join(outputDir, 'verify-move.json'))
  if (!result.ok) {
    console.error(`Pure-move verification failed; report written to ${displayPath}`)
    if (result.modifiedProblems.length > 0) {
      console.error(`Modified files with non-import changes: ${result.modifiedProblems.join(', ')}`)
    }
    if (result.orderProblems.length > 0) {
      console.error(`Moved files with token-order changes: ${result.orderProblems.length}`)
    }
    if (result.unsupported.length > 0) {
      console.error(`Unsupported diff statuses: ${result.unsupported.join(', ')}`)
    }
    if (result.tokenProblems.length > 0) {
      console.error(`Token multiset differences: ${result.tokenProblems.length}`)
    }
    process.exit(1)
  }
  console.log(`Pure-move verification passed; report written to ${displayPath}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
