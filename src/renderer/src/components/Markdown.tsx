import { isValidElement, cloneElement, useEffect, type ReactElement } from 'react'
import { Streamdown } from 'streamdown'
import { CodeBlock, warmHighlighter } from './CodeBlock'

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
    isValidElement(children) ? cloneElement(children as ReactElement, { 'data-block': true }) : children
}

export function Markdown({ children }: { children: string }): JSX.Element {
  // MQA-270 (B3): warm shiki when markdown actually mounts — see warmHighlighter's comment for why this
  // moved out of CodeBlock's module scope. Idempotent (hlPromise singleton), so re-mounts are free.
  useEffect(() => warmHighlighter(), [])
  return (
    <div className="md">
      <Streamdown components={components} shikiTheme={['catppuccin-mocha', 'catppuccin-mocha']}>
        {children}
      </Streamdown>
    </div>
  )
}
