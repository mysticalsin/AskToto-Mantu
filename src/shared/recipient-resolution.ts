/**
 * Recipient resolution (Métis 2.12 G34, R010 / R-19). Pure.
 *
 * Anything that would send, share or address someone gets its recipient from trusted UI state only:
 *
 *  1. an explicit pick in Métis UI (a contact the owner chose);
 *  2. the owner's own selection in the target app, as main observed it for THIS gesture;
 *  3. an exact full-name match against the owner's own contacts, in the owner's own typed or spoken command.
 *
 * Words from another meeting participant, screen text, a document, a connector or a model are data (G36): they
 * never name a recipient, even when they quote a real contact, and a raw address in any text never resolves,
 * because only an address that is already a trusted candidate can be a recipient. Ambiguity or no trusted source
 * means no action and honest copy asking the owner to pick.
 */
import { mayProposeActions, type ContextRecord } from './context-authority'
import type { GestureBinding } from './gesture-binding'

export type RecipientSource = 'explicit-pick' | 'target-selection' | 'owner-contacts'

export interface OwnerContact {
  readonly id: string
  readonly label: string
  readonly address: string
}

/** What main observed the owner selecting in the target app during this gesture (never renderer supplied). */
export interface TrustedSelection {
  readonly bindingId: string
  readonly address: string
}

/** The owner's explicit choice in Métis UI, minted by main from the pick IPC for this gesture. */
export interface ExplicitPick {
  readonly bindingId: string
  readonly contactId: string
}

export interface ResolvedRecipient {
  readonly address: string
  readonly source: RecipientSource
  readonly label?: string
}

export type RecipientResolution =
  | { status: 'resolved'; recipient: ResolvedRecipient }
  | { status: 'ambiguous'; options: readonly OwnerContact[] }
  | { status: 'unresolved'; reason: 'no_trusted_source' }

export interface RecipientInputs {
  binding: GestureBinding | null
  pick?: ExplicitPick | null
  selection?: TrustedSelection | null
  contacts?: readonly OwnerContact[]
  /** The command text. Only an owner-origin instruction record can name a contact. */
  ownerRequest?: ContextRecord | null
  /** Captured content (transcript lines, screen text, documents, model output). Accepted and never consulted. */
  untrusted?: readonly ContextRecord[]
}

const norm = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function contactsNamedIn(text: string, contacts: readonly OwnerContact[]): OwnerContact[] {
  const haystack = ` ${norm(text).replace(/[^\p{L}\p{N}@.' -]/gu, ' ')} `
  return contacts.filter((contact) => {
    const label = norm(contact.label)
    return (
      label.length > 0 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(label)}(?![\\p{L}\\p{N}])`, 'u').test(haystack)
    )
  })
}

const UNRESOLVED: RecipientResolution = { status: 'unresolved', reason: 'no_trusted_source' }

export function resolveRecipient(input: RecipientInputs): RecipientResolution {
  const { binding } = input
  if (!binding) return UNRESOLVED
  const contacts = input.contacts ?? []

  const pick = input.pick
  if (pick && pick.bindingId === binding.bindingId) {
    const chosen = contacts.find((contact) => contact.id === pick.contactId)
    return chosen
      ? { status: 'resolved', recipient: { address: chosen.address, source: 'explicit-pick', label: chosen.label } }
      : UNRESOLVED
  }

  const candidates: ResolvedRecipient[] = []
  if (input.selection && input.selection.bindingId === binding.bindingId && input.selection.address) {
    candidates.push({ address: input.selection.address, source: 'target-selection' })
  }
  const named = mayProposeActions(input.ownerRequest ?? null) ? contactsNamedIn(input.ownerRequest!.text, contacts) : []
  const options = new Map<string, OwnerContact>()
  for (const contact of named) options.set(contact.id, contact)

  if (named.length > 0) {
    // Two contacts with the same full name (or two names in the request): the owner picks.
    if (new Set(named.map((contact) => norm(contact.address))).size > 1) {
      return { status: 'ambiguous', options: [...options.values()] }
    }
    candidates.push({ address: named[0].address, source: 'owner-contacts', label: named[0].label })
  }

  const addresses = new Set(candidates.map((candidate) => norm(candidate.address)))
  if (addresses.size === 0) return UNRESOLVED
  if (addresses.size > 1) {
    const offered = new Map(options)
    for (const contact of contacts) if (addresses.has(norm(contact.address))) offered.set(contact.id, contact)
    return { status: 'ambiguous', options: [...offered.values()] }
  }
  return { status: 'resolved', recipient: candidates.find((c) => c.source === 'target-selection') ?? candidates[0] }
}

const RECIPIENT_KEYS = /^(to|cc|bcc|recipients?|attendees?|addressee|send_?to)$/i

/** Every address-like value in action arguments under a recipient-bearing key. */
export function recipientFieldsIn(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const found: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!RECIPIENT_KEYS.test(key)) continue
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) if (typeof entry === 'string' && entry.trim()) found.push(entry.trim())
  }
  return found
}

/** The arguments may address only the one recipient main resolved from trusted state. */
export function recipientsMatchResolution(fields: readonly string[], resolved: ResolvedRecipient): boolean {
  const wanted = norm(resolved.address)
  return fields.length > 0 && fields.every((field) => norm(field) === wanted)
}

export type RecipientRefusal = 'unresolved' | 'ambiguous' | 'target_changed'

/** Honest sentences. They never repeat an address or name taken from content. */
export function recipientRefusalCopy(reason: RecipientRefusal): string {
  switch (reason) {
    case 'ambiguous':
      return 'More than one person fits. Pick who this is for, and nothing is sent until you do.'
    case 'target_changed':
      return 'You switched apps, so Métis stopped. Nothing was done. Try again where you want it to happen.'
    default:
      return 'Métis can’t tell who this is for. Choose who it goes to; nothing was sent.'
  }
}
