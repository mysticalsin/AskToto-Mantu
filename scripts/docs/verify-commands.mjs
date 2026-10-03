#!/usr/bin/env node
// Command verifier for the docs (M2-0172): every fenced block marked `verify` or `verify-dry` in
// README.md, AGENTS.md and the runbooks is checked against one commit, so a documented command cannot
// name a script, file or config that the release commit does not have.
//
//   node scripts/docs/verify-commands.mjs --commit <sha> [--out <dir>]
//
// ```bash verify      the command is resolved against the commit AND executed in this checkout
//                     (which must be that commit). Only read-only, self-contained commands qualify.
// ```bash verify-dry  the command is only resolved against the commit's tree, never executed. Required for
//                     anything that installs, builds, packages, deploys, migrates, publishes or runs the app.
//
// A command the resolver does not understand is a failure, never a skip. README.md, AGENTS.md and every
// docs/runbooks/*.md must carry at least one marked block, so marking nothing cannot pass. --out gets
// report.json and report.md (default out/docs-verify). Exit 0 = all verified, 1 = failures, 2 = bad usage.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const DEFAULT_OUT = 'out/docs-verify'
const RUNBOOKS_DIR = 'docs/runbooks'

// A command that installs, builds, packages, deploys, migrates, publishes or launches the app is never
// executed by this tool, whatever the block says.
const SIDE_EFFECTS =
  /\bnpm\s+(?:ci|install|run\s+(?:dev|start|preview|build\S*|dist\S*|release\S*|installers\S*|predist\S*|package\S*|deploy\S*|migrate\S*|embed-cloudflare-key|fetch-models|test\S*))\b|\bnpm\s+(?:test|start)\b|\bnpx\s+(?:vitest|wrangler)\b|\bwrangler\b|\bgit\s+(?:push|tag|commit|reset|checkout|clean)\b|embed-cloudflare-key|deploy\.mjs|migrate\.mjs|\bgh\s+release\b/

/** @returns {{file: string, line: number, mode: 'verify'|'verify-dry', commands: string[]}[]} */
export function extractBlocks(markdown, file = '') {
  const blocks = []
  let open = null
  markdown.replace(/\r\n/g, '\n').split('\n').forEach((text, index) => {
    const fence = /^[ \t]*(`{3,})(.*)$/.exec(text)
    if (!open) {
      if (!fence) return
      const mode = fence[2].trim().split(/\s+/).find((word) => word === 'verify' || word === 'verify-dry')
      open = { ticks: fence[1].length, mode, line: index + 1, lines: [] }
    } else if (fence && fence[1].length >= open.ticks && !fence[2].trim()) {
      if (open.mode) blocks.push({ file, line: open.line, mode: open.mode, commands: toCommands(open.lines) })
      open = null
    } else {
      open.lines.push(text)
    }
  })
  return blocks
}

/** Joins `\` continuations, drops blank and comment lines, a leading `$ ` and a trailing ` # note`. */
function toCommands(lines) {
  const commands = []
  let pending = ''
  for (const raw of lines) {
    const joined = pending + raw.trim()
    if (joined.endsWith('\\')) {
      pending = joined.slice(0, -1).trimEnd() + ' '
      continue
    }
    pending = ''
    const command = joined.replace(/^\$\s+/, '').replace(/\s+#(?:\s.*)?$/, '').trim()
    if (command && !command.startsWith('#')) commands.push(command)
  }
  return commands
}

/**
 * Resolves one command against the tree. `tree` = { exists(path), readJson(path) }, both at the commit.
 * `state.cwd` is the repo-relative directory a preceding `cd` moved into.
 * @returns {string|null} the reason it does not resolve, or null.
 */
export function resolveCommand(command, tree, state) {
  const tokens = command.split(/\s+/)
  const at = (path) => posix.normalize(posix.join(state.cwd, path))
  const missing = (path) => (tree.exists(at(path)) ? null : `${at(path)} does not exist at the commit`)
  const [tool, ...args] = tokens
  if (tool === 'cd') {
    const problem = args.length === 1 ? missing(args[0]) : 'cd takes exactly one directory'
    if (!problem) state.cwd = at(args[0])
    return problem
  }
  if (tool === 'npm') {
    const [sub, name] = args
    if (sub === 'ci' || sub === 'install') return null
    const scripts = tree.readJson(at('package.json'))?.scripts ?? {}
    if (sub === 'test' || sub === 'start') return scripts[sub] ? null : `package.json has no "${sub}" script`
    if (sub === 'run') return scripts[name] ? null : `package.json has no "${name}" script`
    return `npm ${sub} is not a command this verifier understands`
  }
  if (tool === 'node' || tool === 'bash') {
    const file = args.find((arg) => !arg.startsWith('-'))
    return file ? missing(file) : `${tool} without a file`
  }
  if (tool === 'npx' && args[0] === 'tsc') {
    const config = args[args.indexOf('-p') + 1]
    return args.includes('-p') && config ? missing(config) : null
  }
  if (tool === 'npx' && args[0] === 'vitest') {
    const paths = args.slice(1).filter((arg) => /\.(?:test|spec)\.\w+$/.test(arg))
    return paths.map(missing).find(Boolean) ?? null
  }
  if (tool === 'gh' && args[0] === 'run' && ['view', 'list', 'watch'].includes(args[1])) return null
  return `${tool} is not a command this verifier understands`
}

/**
 * @param {{file: string, line: number, mode: string, commands: string[]}[]} blocks
 * @param {{tree: object, run: (command: string, cwd: string) => {status: number|null, output: string}}} env
 */
export function verifyBlocks(blocks, { tree, run }) {
  const results = []
  for (const block of blocks) {
    const state = { cwd: '' }
    for (const command of block.commands) {
      const result = { file: block.file, line: block.line, mode: block.mode, command, status: 'PASS', detail: '' }
      const resolveProblem = resolveCommand(command, tree, state)
      if (resolveProblem) {
        Object.assign(result, { status: 'FAIL', detail: resolveProblem })
      } else if (block.mode === 'verify' && /^cd\s/.test(command)) {
        result.detail = 'resolved'
      } else if (block.mode === 'verify') {
        if (SIDE_EFFECTS.test(command)) {
          Object.assign(result, { status: 'FAIL', detail: 'has side effects; mark the block verify-dry' })
        } else {
          const { status, output } = run(command, state.cwd)
          Object.assign(result, status === 0 ? { detail: 'executed, exit 0' } : { status: 'FAIL', detail: `exit ${status}: ${output.slice(-400)}` })
        }
      } else {
        result.detail = 'resolved (dry-run)'
      }
      results.push(result)
    }
  }
  return results
}

export function requiredFiles(root) {
  const runbooks = readdirSync(join(root, RUNBOOKS_DIR)).filter((name) => name.endsWith('.md')).sort()
  return ['README.md', 'AGENTS.md', ...runbooks.map((name) => `${RUNBOOKS_DIR}/${name}`)]
}

/** Files that must carry a marked block but carry none. */
export function unmarkedFiles(files, blocks) {
  const marked = new Set(blocks.map((block) => block.file))
  return files.filter((file) => !marked.has(file))
}

export function renderMarkdown({ commit, results, unmarked }) {
  const failed = results.filter((r) => r.status === 'FAIL')
  const lines = [`# Docs command verification: ${failed.length === 0 && unmarked.length === 0 ? 'PASS' : 'FAIL'}`, '', `Commit: \`${commit}\``, '']
  for (const file of unmarked) lines.push(`- FAIL ${file}: no block marked verify or verify-dry`)
  for (const r of results) lines.push(`- ${r.status} ${r.file}:${r.line} [${r.mode}] \`${r.command}\` - ${r.detail}`)
  return lines.join('\n') + '\n'
}

function gitTree(root, commit) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    exists(path) {
      try {
        git('cat-file', '-e', `${commit}:${path}`)
        return true
      } catch {
        return false
      }
    },
    readJson(path) {
      try {
        return JSON.parse(git('show', `${commit}:${path}`))
      } catch {
        return null
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { commit: { type: 'string' }, out: { type: 'string', default: DEFAULT_OUT }, root: { type: 'string', default: REPO_ROOT } }
  })
  if (!values.commit) {
    console.error('usage: verify-commands.mjs --commit <sha> [--out <dir>]')
    process.exit(2)
  }
  const root = resolve(values.root)
  const gitOut = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const commit = gitOut('rev-parse', `${values.commit}^{commit}`)
  if (gitOut('rev-parse', 'HEAD') !== commit) {
    console.error(`the checkout is at ${gitOut('rev-parse', 'HEAD')}, not ${commit}: verify blocks execute here, so check the commit out first`)
    process.exit(2)
  }
  const files = requiredFiles(root)
  const blocks = files.flatMap((file) => extractBlocks(readFileSync(join(root, file), 'utf8'), file))
  const run = (command, cwd) => {
    const done = spawnSync(command, { shell: true, cwd: join(root, cwd), encoding: 'utf8', timeout: 300_000 })
    return { status: done.status, output: `${done.stdout ?? ''}${done.stderr ?? ''}` }
  }
  const results = verifyBlocks(blocks, { tree: gitTree(root, commit), run })
  const unmarked = unmarkedFiles(files, blocks)
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'report.json'), JSON.stringify({ commit, files, results, unmarked }, null, 2) + '\n')
  writeFileSync(join(out, 'report.md'), renderMarkdown({ commit, results, unmarked }))
  const failed = results.filter((r) => r.status === 'FAIL')
  for (const r of failed) console.error(`${r.file}:${r.line} \`${r.command}\`: ${r.detail}`)
  for (const file of unmarked) console.error(`${file}: no block marked verify or verify-dry`)
  console.log(`docs command verification: ${results.length - failed.length}/${results.length} commands ok, ${unmarked.length} unmarked file(s)`)
  process.exit(failed.length === 0 && unmarked.length === 0 ? 0 : 1)
}
