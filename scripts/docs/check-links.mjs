#!/usr/bin/env node
// Link check over the repository docs (M2-0172): every relative markdown link and html src/href in
// docs/**/*.md, README.md and AGENTS.md must resolve to a file or directory in this checkout. External
// URLs and same-page anchors are not fetched; fenced blocks and inline code are examples, not links.
//
//   node scripts/docs/check-links.mjs [--root <dir>]
//
// Exit 0 = every relative link resolves; 1 = at least one broken link, listed on stderr.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm
// An inline code span may wrap across lines but never across a blank line.
const INLINE_CODE = /`(?:(?!\n[ \t]*\n)[^`])*`/g
const MARKDOWN_LINK = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g
const HTML_REF = /\b(?:src|href)="([^"]+)"/g
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/|<)/i

export function extractTargets(markdown) {
  const prose = markdown.replace(/\r\n/g, '\n').replace(FENCED, '').replace(INLINE_CODE, '')
  const targets = []
  for (const re of [MARKDOWN_LINK, HTML_REF]) {
    for (const match of prose.matchAll(re)) targets.push(match[1])
  }
  return targets.filter((target) => !EXTERNAL.test(target))
}

function decodePath(target) {
  const path = target.split('#')[0].split('?')[0]
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function markdownFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...markdownFiles(full))
    else if (entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

/** @returns {{file: string, target: string}[]} every relative link that does not resolve, repo-relative. */
export function checkLinks(root = REPO_ROOT) {
  const files = [join(root, 'README.md'), join(root, 'AGENTS.md'), ...markdownFiles(join(root, 'docs'))]
  const broken = []
  for (const file of files) {
    for (const target of extractTargets(readFileSync(file, 'utf8'))) {
      const path = decodePath(target)
      if (path && !existsSync(resolve(dirname(file), path))) {
        broken.push({ file: relative(root, file).split('\\').join('/'), target })
      }
    }
  }
  return broken
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: REPO_ROOT } } })
  const broken = checkLinks(resolve(values.root))
  for (const { file, target } of broken) console.error(`${file}: broken link ${target}`)
  console.log(`docs link check: ${broken.length} broken link(s)`)
  process.exit(broken.length === 0 ? 0 : 1)
}
