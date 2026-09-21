import { isValidElement, cloneElement, useEffect, useRef, type ReactElement } from 'react'
import { Streamdown } from 'streamdown'
import { CodeBlock, warmHighlighter } from './CodeBlock'
import { safeHref } from '@shared/safe-url'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Override streamdown's code rendering with our shiki block (reliable colors) and
// flatten <pre> so we don't double-wrap. Table is left to streamdown's default renderer:
// it already emits a real <table> inside its own horizontally-scrollable wrapper, which is
// what the `.md table` CSS below targets and what gives us the built-in copy-table button.
//
// Streamdown's OWN default `pre` does the same flattening, but first clones its child (the
// already-rendered `code` element) to stamp a `data-block` prop on it — that's the ONLY signal a
// fenced ``` block carries (there is no `inline` prop; streamdown never passes one). Skipping that
// clone used to drop the signal entirely, forcing CodeBlock to guess from language/newlines, which
// misclassified a single-line fence with no language as inline. Mirror streamdown's own trick so
// CodeBlock can tell fenced from inline reliably.
const components: any = {
  code: CodeBlock,
  pre: ({ children }: any) =>
    isValidElement(children) ? cloneElement(children as ReactElement, { 'data-block': true }) : children,
  a: ({ href, children, ...rest }: any) => {
    const safe = safeHref(href)
    if (!safe) return <span>{children}</span>
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    )
  }
}

// A fence can arrive before its closing delimiter while an answer streams, so detect its opener
// rather than waiting for a fully parseable block. Up to three leading spaces is valid Markdown.
const FENCED_CODE = /(?:^|\n) {0,3}(?:`{3,}|~{3,})/u

export function shouldWarmHighlighter(warmed: boolean, markdown: string): boolean {
  return !warmed && FENCED_CODE.test(markdown)
}

export function Markdown({ children }: { children: string }): JSX.Element {
  // Plain streamed answers should not schedule Shiki. When a real fence arrives, warm once before the
  // block renderer's debounce fires so the first code block stays responsive.
  const warmed = useRef(false)
  useEffect(() => {
    if (!shouldWarmHighlighter(warmed.current, children)) return
    warmed.current = true
    warmHighlighter()
  }, [children])
  return (
    <div className="md">
      <Streamdown components={components} shikiTheme={['catppuccin-mocha', 'catppuccin-mocha']}>
        {children}
      </Streamdown>
    </div>
  )
}
