import { useEffect, useRef, useState } from 'react'
// Curated, fine-grained shiki: only the languages below ship, instead of the full ~200-grammar bundle
// that `codeToHtml` from 'shiki' pulls in (which code-split into wolfram/emacs-lisp/cpp megachunks).
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import githubDark from 'shiki/themes/github-dark.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import jsx from 'shiki/langs/jsx.mjs'
import json from 'shiki/langs/json.mjs'
import python from 'shiki/langs/python.mjs'
import bash from 'shiki/langs/bash.mjs'
import html from 'shiki/langs/html.mjs'
import css from 'shiki/langs/css.mjs'
import go from 'shiki/langs/go.mjs'
import rust from 'shiki/langs/rust.mjs'
import java from 'shiki/langs/java.mjs'
import clang from 'shiki/langs/c.mjs'
import cpp from 'shiki/langs/cpp.mjs'
import csharp from 'shiki/langs/csharp.mjs'
import ruby from 'shiki/langs/ruby.mjs'
import php from 'shiki/langs/php.mjs'
import sql from 'shiki/langs/sql.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import toml from 'shiki/langs/toml.mjs'
import markdown from 'shiki/langs/markdown.mjs'
import swift from 'shiki/langs/swift.mjs'
import kotlin from 'shiki/langs/kotlin.mjs'
import scala from 'shiki/langs/scala.mjs'
import diff from 'shiki/langs/diff.mjs'
import { Copy, Check } from 'lucide-react'

// Alias any incoming fence language → a loaded grammar, else 'text' (built-in, no grammar needed).
const ALIAS: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript', tsx: 'tsx', js: 'javascript', javascript: 'javascript',
  jsx: 'jsx', json: 'json', python: 'python', py: 'python', bash: 'bash', sh: 'bash', shell: 'bash',
  shellscript: 'bash', zsh: 'bash', html: 'html', xml: 'html', css: 'css', go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust', java: 'java', c: 'c', 'c++': 'cpp', cpp: 'cpp', cc: 'cpp', csharp: 'csharp',
  cs: 'csharp', 'c#': 'csharp', ruby: 'ruby', rb: 'ruby', php: 'php', sql: 'sql', yaml: 'yaml',
  yml: 'yaml', toml: 'toml', markdown: 'markdown', md: 'markdown', swift: 'swift', kotlin: 'kotlin',
  kt: 'kotlin', scala: 'scala', diff: 'diff', patch: 'diff'
}
const norm = (l: string): string => ALIAS[(l || '').toLowerCase()] || 'text'

let hlPromise: Promise<HighlighterCore> | null = null
/** Singleton highlighter — created once with the curated grammar set, reused for every block. */
function highlighter(): Promise<HighlighterCore> {
  if (!hlPromise) {
    hlPromise = createHighlighterCore({
      themes: [githubDark],
      langs: [
        typescript, tsx, javascript, jsx, json, python, bash, html, css, go, rust, java, clang, cpp,
        csharp, ruby, php, sql, yaml, toml, markdown, swift, kotlin, scala, diff
      ],
      engine: createOnigurumaEngine(import('shiki/wasm'))
    })
  }
  return hlPromise
}

/** Block code with real shiki colors (inline-styled spans → always render). */
function Block({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    // Debounce: while an answer streams, `code` grows every token — re-highlighting each one is
    // O(n^2). Collapse rapid updates into one highlight ~90ms after the last change.
    const t = setTimeout(() => {
      highlighter()
        .then((h) => alive && setHtml(h.codeToHtml(code, { lang: norm(lang), theme: 'github-dark' })))
        .catch(() => alive && setHtml(''))
    }, 90)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code, lang])

  const copy = (): void => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => {})
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-xl border border-[var(--color-hair-soft)]">
      <div className="flex items-center justify-between border-b border-[var(--color-hair-soft)] bg-white/[0.05] px-3 py-1.5">
        <span className="font-ui text-[10px] uppercase tracking-wide text-[color:var(--color-ink-2)]">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={copy}
          className={[
            'no-drag focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-white/10',
            copied ? 'text-[var(--color-success)]' : 'text-[color:var(--color-ink-2)] hover:text-[color:var(--color-ink)]'
          ].join(' ')}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {html ? (
        <div
          ref={ref}
          className="sd-shiki overflow-x-auto p-3 text-[12.5px] leading-relaxed [&_pre]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed text-[color:var(--color-ink)]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Drop-in for streamdown/markdown `code`: block → shiki, inline → pill. */
export function CodeBlock(props: any): JSX.Element {
  const { className, children, inline } = props
  const text = String(children ?? '').replace(/\n$/, '')
  const lang = /language-(\w+)/.exec(className || '')?.[1] || ''
  const isBlock = !inline && (lang !== '' || text.includes('\n'))
  if (!isBlock) {
    return (
      <code className="rounded-[5px] bg-white/[0.09] px-[0.36em] py-[0.1em] text-[0.9em]">
        {children}
      </code>
    )
  }
  return <Block code={text} lang={lang} />
}
