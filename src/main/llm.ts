import type { StreamOptions, StreamHandle } from './llm/shared'
import { streamCli } from './llm/cli'
import { streamDust } from './llm/dust'
import { streamAnthropic } from './llm/anthropic'
import { streamOpenAI } from './llm/openai'
import { streamLocal } from './llm/local'

// Re-export the public types so existing `./llm` importers keep working after the strategy split.
export type { StreamHandlers, StreamOptions, StreamHandle } from './llm/shared'

/**
 * Provider-strategy dispatcher. Each provider kind owns its own module (src/main/llm/<kind>.ts) behind a
 * single StreamOptions → StreamHandle contract. Adding a provider kind is a new strategy module + one case
 * here — not another 150-line branch in a God-function. OpenAI-compatible is the default for any
 * non-cli/dust/anthropic kind (GPT, Kimi/Moonshot, a custom base URL).
 */
export function createStream(opts: StreamOptions): StreamHandle {
  switch (opts.kind) {
    case 'cli':
      return streamCli(opts)
    case 'dust':
      return streamDust(opts)
    case 'anthropic':
      return streamAnthropic(opts)
    case 'local':
      return streamLocal(opts)
    default:
      return streamOpenAI(opts)
  }
}
