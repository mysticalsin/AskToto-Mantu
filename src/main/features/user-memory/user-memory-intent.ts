/**
 * What the owner said that is a request to remember (G57). Pure and deliberately narrow: the WHOLE turn must be one
 * short explicit statement ("remember that ...", "call me Tony", "from now on answer in Portuguese", "I'm working on
 * ..."). A question, a long paste or a sentence that only mentions these words is never matched, so ordinary asks
 * remember nothing. The caller has already established that the turn is the owner's own typed or spoken command (G36);
 * this module never sees content from a meeting, a screen or a document.
 */
import { USER_MEMORY_TEXT_MAX_CHARS, type UserMemoryKind } from '@shared/user-memory'

export interface RememberIntent {
  kind: UserMemoryKind
  text: string
}

const stripEnd = (text: string): string => text.trim().replace(/[\s.!]+$/u, '')
const upFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export function parseRememberIntent(turn: string): RememberIntent | null {
  if (typeof turn !== 'string') return null
  const t = turn.trim()
  if (t.length < 6 || t.length > USER_MEMORY_TEXT_MAX_CHARS || /[\r\n?]/.test(t)) return null

  const project =
    /^(?:please\s+)?(?:remember\s+(?:that\s+)?)?(?:i(?:'|’)m|i am)\s+(?:currently\s+)?working\s+on\s+(.+)$/i.exec(t) ??
    /^(?:please\s+)?(?:remember\s+(?:that\s+)?)?my\s+(?:current\s+)?project\s+is\s+(.+)$/i.exec(t)
  if (project) {
    const what = stripEnd(project[1])
    return what ? { kind: 'project-context', text: `Working on ${what}` } : null
  }

  const callMe = /^(?:please\s+)?call\s+me\s+(.+)$/i.exec(t)
  if (callMe) {
    const name = stripEnd(callMe[1])
    return name && name.split(/\s+/).length <= 4 && !/^(?:back|later|tomorrow|when|if|asap|now)\b/i.test(name)
      ? { kind: 'preference', text: `Call the owner ${name}` }
      : null
  }

  const fromNow = /^(?:please\s+)?(?:from\s+now\s+on|always)[,\s]+(.+)$/i.exec(t)
  if (fromNow) {
    const what = stripEnd(fromNow[1])
    return what ? { kind: 'preference', text: upFirst(what) } : null
  }

  const remember = /^(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i.exec(t)
  if (remember) {
    const what = stripEnd(remember[1])
    return what ? { kind: 'preference', text: upFirst(what) } : null
  }
  return null
}
