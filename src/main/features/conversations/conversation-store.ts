import {
  createSealedScopedStore,
  type SealedScope,
  type SealedScopedIo,
  type SealedScopedStore
} from '../../infra/storage/sealed-scoped-store'
import { IndexDocSchema, TurnDocSchema, type IndexDoc, type Turn, type TurnDoc } from './conversation-model'

export interface ConversationStoreDeps {
  /** One sealed index file per partition, and one sealed turn file per conversation (`name` is its id). */
  indexIo: SealedScopedIo
  turnIo: SealedScopedIo
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  scope(): SealedScope | null
}

export interface ConversationStore {
  /** Conversations (turns referenced by id) and composer drafts of every owner in the partition file. */
  index: SealedScopedStore<IndexDoc>
  /** The turns of one conversation: `transact(fn, scope, conversationId)`. */
  turns: SealedScopedStore<TurnDoc>
}

export function createConversationStore(deps: ConversationStoreDeps): ConversationStore {
  const { seal, open, scope } = deps
  return {
    index: createSealedScopedStore<IndexDoc>({
      schema: IndexDocSchema,
      empty: (s) => ({ v: 1, ...s, conversations: [], drafts: [] }),
      io: deps.indexIo,
      seal,
      open,
      scope
    }),
    turns: createSealedScopedStore<TurnDoc>({
      schema: TurnDocSchema,
      empty: (s, name) => ({ v: 1, ...s, conversationId: name ?? '', turns: [] }),
      accept: (doc, name) => doc.conversationId === name,
      io: deps.turnIo,
      seal,
      open,
      scope
    })
  }
}

/**
 * The turns that are committed: a turn file is written before the index that counts it, so a crash between the two
 * writes leaves turns past `lastSeq`. They are never shown and the next append overwrites them.
 */
export const committedTurns = (doc: TurnDoc, lastSeq: number): Turn[] =>
  doc.turns.filter((turn) => turn.seq <= lastSeq).sort((a, b) => a.seq - b.seq)
