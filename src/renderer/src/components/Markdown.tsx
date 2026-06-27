import { Streamdown } from 'streamdown'
import { CodeBlock } from './CodeBlock'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Override streamdown's code rendering with our shiki block (reliable colors),
// flatten <pre> so we don't double-wrap, and wrap tables for horizontal scroll.
const components: any = {
  code: CodeBlock,
  pre: ({ children }: any) => children,
  table: ({ children }: any) => <div className="overflow-x-auto">{children}</div>
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
