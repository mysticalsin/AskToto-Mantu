import { runCliStream } from '../cli'
import { type StreamOptions, type StreamHandle, userText } from './shared'

/** CLI providers (claude-cli, codex-cli) — spawn the local binary, no API key required. */
export function streamCli(opts: StreamOptions): StreamHandle {
  // Flatten conversation history + current turn into a single prompt string.
  const prompt = [
    ...opts.req.history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`),
    userText(opts.req)
  ].join('\n\n')
  return runCliStream({
    providerId: opts.providerId,
    model: opts.model,
    system: opts.system,
    prompt,
    handlers: opts.handlers
  })
}
