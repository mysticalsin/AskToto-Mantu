import type { TranscriptLine } from './ipc'

/** MQA-312: audio sides are not people. Unidentified mixed speech can establish only a lower bound. */
export function reviewSpeakerLabel(lines: readonly TranscriptLine[]): string {
  const names = new Set<string>()
  const named = { you: new Set<string>(), them: new Set<string>(), unknown: new Set<string>() }
  const unnamed = new Set<TranscriptLine['speaker']>()
  for (const line of lines) {
    if (line.provisional || !line.text.trim()) continue
    const name = line.name?.normalize('NFC').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (name) {
      names.add(name)
      named[line.speaker].add(name)
    } else {
      unnamed.add(line.speaker)
    }
  }

  let count = names.size
  const unnamedYou = unnamed.has('you') && named.you.size === 0
  const unnamedThem = unnamed.has('them') && named.them.size === 0
  // Mic speech establishes You separately from named remote speakers (and vice versa), but an
  // identity on a mixed/unknown channel could already be that person. Never add it twice by guessing.
  if (unnamedYou) count = Math.max(count, named.them.size + 1)
  if (unnamedThem) count = Math.max(count, named.you.size + 1)
  if (unnamedYou && unnamedThem) count = Math.max(count, 2)
  if (count === 0) return 'Speakers not yet identified'

  const uncertain = unnamed.has('them') || unnamed.has('unknown') || (unnamedYou && named.unknown.size > 0)
  return `${uncertain ? 'At least ' : ''}${count} speaker${count === 1 ? '' : 's'}`
}
