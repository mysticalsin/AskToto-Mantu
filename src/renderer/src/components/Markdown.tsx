import { cloneElement, isValidElement } from 'react'
import { Streamdown } from 'streamdown'
import { CodeBlock } from './CodeBlock'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Override streamdown's code rendering with our shiki block (reliable colors) and
// flatten <pre> so we don't double-wrap. Table is left to streamdown's default renderer:
// it already emits a real <table> inside its own horizontally-scrollable wrapper, which is
// what the `.md table` CSS below targets and what gives us the built-in copy-table button.
const components: any = {
  code: CodeBlock,
  // Mirror streamdown's OWN default `pre` (which stamps `data-block="true"` on its single child before
  // flattening) instead of just returning the child bare — CodeBlock relies on that prop, not a
  // lang/newline guess, to tell a real fenced block apart from an inline `code` span (see CodeBlock.tsx).
  pre: ({ children }: any) =>
    isValidElement(children) ? cloneElement(children, { 'data-block': 'true' } as any) : children
}

export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="md">
      <Streamdown components={components} shikiTheme={['catppuccin-mocha', 'catppuccin-mocha']}>
        {children}
      </Streamdown>
    </div>
  )
}
