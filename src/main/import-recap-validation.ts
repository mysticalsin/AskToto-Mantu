import type { StreamCompletion } from './llm/shared'

type RecapSection = { heading: string; body: string }
type LocalRecapProblem = 'invalid_completion' | 'invalid_format' | 'template_echo'

const normalized = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

/** Top-level H2 sections only: code examples cannot satisfy the recap contract. */
function sections(markdown: string): RecapSection[] {
  const result: RecapSection[] = []
  let fence: { marker: string; length: number } | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined
        continue
      }
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      // CommonMark 4.5: backtick info strings cannot themselves contain backticks. Fence delimiters
      // are syntax, not content: an empty fenced block must not make a recap section nonempty.
      fence = { marker: marker[1][0], length: marker[1].length }
      continue
    } else {
      const heading = /^ {0,3}##[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/.exec(line)
      if (heading) {
        const colon = heading[1].search(/[:：]/)
        result.push({
          heading: normalized(colon < 0 ? heading[1] : heading[1].slice(0, colon)),
          body: colon < 0 ? '' : heading[1].slice(colon + 1).trim()
        })
        continue
      }
    }
    if (result.length) result[result.length - 1].body += `\n${line}`
  }
  return result
}

/**
 * Structural containment, not a factual judge. A normally stopped local response can still be
 * unrelated or omit most sections. Keep such output out of the complete-recap persistence path.
 * Translated headings and additional sections are allowed; facts/owners still need semantic QA.
 */
export function localImportRecapProblem(
  text: string,
  completion: StreamCompletion | undefined,
  systemPrefix: string,
  transcript: string
): LocalRecapProblem | null {
  if (completion?.status !== 'complete' || completion.reason !== 'stop') return 'invalid_completion'
  const declared = sections(systemPrefix)
  const actual = sections(text)
  if (!declared.length || actual.length < declared.length ||
    actual.some((section) => !section.heading || !section.body.trim()) ||
    new Set(actual.map((section) => section.heading)).size !== actual.length) return 'invalid_format'

  const input = normalized(transcript)
  const output = actual.map((section) => normalized(section.body))
  for (const section of declared) {
    // The contract puts each instruction on its heading line. Do not include the prompt's final
    // global directive in the last section's instruction, or legitimate quotes in the transcript.
    const instruction = normalized(section.body.split('\n')[0])
    if (instruction && !input.includes(instruction) && output.some((body) => body.includes(instruction))) {
      return 'template_echo'
    }
  }
  return null
}
