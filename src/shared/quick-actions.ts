export type QuickActionKind = 'factcheck' | 'whatnext' | 'explain' | 'summarize'

export type QuickActionTransport = 'suggest' | 'text' | 'screen' | 'local-error'

export interface QuickActionRoute {
  target: 'answer' | 'copilot'
  transport: QuickActionTransport
}

export interface QuickActionRouteInput {
  kind: QuickActionKind
  input: string
  transcript: string
  canUseScreen: boolean
}

const VERDICT_FORMAT = 'VERDICT: <TRUE|FALSE|MISLEADING|UNVERIFIABLE>'

export function transcriptHasContent(transcript: string): boolean {
  return /\S/.test(transcript)
}

export function buildFactCheckClaimPrompt(claim: string): string {
  const clean = claim.trim()
  return (
    `Fact-check the following claim. Respond in EXACTLY this format and nothing else:\n${VERDICT_FORMAT}\n` +
    'then 2-4 short bullet points (each ≤15 words) explaining why; if it is false or misleading, include the correct fact. Be fast and precise.\n\n' +
    `Claim: "${clean}"`
  )
}

export const FACT_CHECK_SCREEN_PROMPT =
  `Fact-check the most prominent claim visible on my screen. Respond in EXACTLY this format and nothing else:\n${VERDICT_FORMAT}\n` +
  'then 2-4 short bullet points (each ≤15 words); if a claim is false or misleading, include the correct fact. Be fast and precise.'

export function buildWhatNextPrompt(transcript: string, source: 'transcript' | 'screen'): string {
  if (source === 'screen') {
    return (
      'Based on what is visible on my screen, give me the next useful thing to say or do. ' +
      'If there is not enough context, say what context is missing in one short line, then give the safest useful next move.'
    )
  }
  const tx = transcript.trim()
  return (
    'Based on this live conversation, what should I say NEXT to move it forward? Give me the exact words to say, concise and first person.\n\n' +
    'Transcript (THEM = the other person, YOU = me):\n"""\n' +
    tx.slice(-3000) +
    '\n"""'
  )
}

export function buildExplainPrompt(input: string, transcript: string): { prompt: string; source: 'input' | 'transcript' | 'generic' } {
  const clean = input.trim()
  if (clean) {
    return { source: 'input', prompt: `Explain this in simple terms:\n"""\n${clean}\n"""` }
  }
  const tx = transcript.trim()
  if (tx) {
    return { source: 'transcript', prompt: `Explain the key point in this conversation in simple terms:\n"""\n${tx.slice(-3000)}\n"""` }
  }
  return {
    source: 'generic',
    prompt: 'Explain what I should focus on right now. If you need more context, say exactly what to provide.'
  }
}

export function buildSpotlightRefPrompt(transcript: string, typed: string): string {
  const tx = transcript.trim()
  const input = typed.trim()
  const context = input || tx.slice(-3000)
  return (
    'Based on the use case being discussed below, search our references and tell me what relevant sales ' +
    'references or case studies we have, and call out the gaps. Be specific.\n\n' +
    'Use case:\n"""\n' +
    context +
    '\n"""'
  )
}

export function spotlightRefUnavailableMessage(): string {
  return 'Connect Dust and pick a Spotlight Ref agent in Settings → Your AI to check for references.'
}

export function quickActionUnavailableMessage(kind: QuickActionKind): string {
  if (kind === 'summarize') {
    return 'To summarize, start Listen for a transcript or switch to a screen-capable provider in Settings.'
  }
  if (kind === 'factcheck') {
    return 'Type a claim, start Listen, or switch to a screen-capable provider before fact-checking.'
  }
  if (kind === 'whatnext') {
    return 'Start Listen, type context, or switch to a screen-capable provider so AskToto has context for the next move.'
  }
  return 'Type context, start Listen, or switch to a screen-capable provider before using this action.'
}

export function chooseQuickActionRoute(input: QuickActionRouteInput): QuickActionRoute {
  const hasTranscript = transcriptHasContent(input.transcript)
  const hasInput = /\S/.test(input.input)

  if (input.kind === 'whatnext') {
    if (hasTranscript) return { target: 'copilot', transport: 'suggest' }
    if (input.canUseScreen) return { target: 'answer', transport: 'screen' }
    return { target: 'answer', transport: hasInput ? 'text' : 'local-error' }
  }

  if (input.kind === 'factcheck') {
    if (hasInput || hasTranscript) return { target: 'answer', transport: 'text' }
    if (input.canUseScreen) return { target: 'answer', transport: 'screen' }
    return { target: 'answer', transport: 'local-error' }
  }

  if (input.kind === 'explain') {
    // The user typed something explicit to explain — that wins regardless of screen availability.
    if (hasInput) return { target: hasTranscript ? 'copilot' : 'answer', transport: 'text' }
    // No typed input: "Explain" with nothing specified defaults to the screen (its classic overlay
    // meaning — "explain what I'm looking at") rather than the merely-present meeting transcript.
    if (input.canUseScreen) return { target: 'answer', transport: 'screen' }
    if (hasTranscript) return { target: 'copilot', transport: 'text' }
    return { target: 'answer', transport: 'text' }
  }

  if (input.kind === 'summarize') {
    // "Summarize SCREEN" must actually look at the screen whenever it can — a transcript merely being
    // present (i.e. any time a meeting is running) must not silently swap this for a transcript summary.
    if (input.canUseScreen) return { target: 'answer', transport: 'screen' }
    if (hasTranscript) return { target: 'answer', transport: 'text' }
    return { target: 'answer', transport: 'local-error' }
  }

  return { target: 'answer', transport: 'local-error' }
}
