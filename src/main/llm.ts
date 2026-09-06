import type { StreamOptions, StreamHandle } from './llm/shared'
import { streamCli } from './llm/cli'
import { streamDust } from './llm/dust'
import { streamAnthropic } from './llm/anthropic'
import { streamOpenAI } from './llm/openai'
import { streamLocal } from './llm/local'
import { streamOperatorUse } from './llm/operator-use'
import { wrapEnterpriseStream } from './llm/enterprise-client'
import { auditLog } from './logger'

// Re-export the public types so existing `./llm` importers keep working after the strategy split.
export type { StreamHandlers, StreamOptions, StreamHandle } from './llm/shared'

/**
 * Raw strategy switch. Tests that want the unwrapped dispatcher can import this; production
 * always goes through createStream → wrapEnterpriseStream.
 */
export function dispatchStream(opts: StreamOptions): StreamHandle {
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

/**
 * The one client every provider walks through: hard timeout, cancel, TTFT/TTA, answer-first
 * post-filter, secret-redacted errors. Strategies below this still own wire format.
 */
export function createStream(opts: StreamOptions): StreamHandle {
  const dispatch = opts.operatorBroker
    ? (o: StreamOptions): StreamHandle =>
        streamOperatorUse({
          ...o,
          operator: o.operator ?? {}
        })
    : dispatchStream
  return wrapEnterpriseStream(dispatch, opts, {
    onMetrics: (m) =>
      auditLog('llm.call', {
        provider: m.providerId,
        ttftMs: m.ttftMs,
        ttaMs: m.ttaMs,
        cancelled: m.cancelled,
        timedOut: m.timedOut,
        circuitOpen: m.circuitOpen
      })
  })
}
