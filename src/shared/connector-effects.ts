/** The catalog's `ConnectorEffect` values, restated here so the catalog can import this file without a cycle. */
type CatalogEffect = 'read' | 'create' | 'send' | 'modify' | 'delete'

/**
 * What a connector call does to the outside world (G64, CAP-07). `read` runs without a card; every other class
 * needs the owner's confirm card and an ActionGuard approval. An unknown tool or operation is `irreversible_write`.
 */
export const CONNECTOR_EFFECT_CLASSES = ['read', 'reversible_write', 'irreversible_write', 'send'] as const
export type ConnectorEffectClass = (typeof CONNECTOR_EFFECT_CLASSES)[number]

export function requiresConfirm(cls: ConnectorEffectClass): boolean {
  return cls !== 'read'
}

/** The classes a catalog operation of this effect may declare. */
export function allowedClassesFor(effect: CatalogEffect): readonly ConnectorEffectClass[] {
  switch (effect) {
    case 'read':
      return ['read']
    case 'create':
    case 'modify':
      return ['reversible_write', 'irreversible_write']
    case 'delete':
      return ['irreversible_write']
    case 'send':
      return ['send']
  }
}
