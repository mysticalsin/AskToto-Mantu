/**
 * Convention for a settings feature module.
 *
 * A feature that owns persisted settings keeps its zod shape in its own `src/shared/<feature>-settings.ts`
 * and exports one descriptor made here. `BaseSettingsSchema` spreads the shape (so ipc.ts grows by one spread,
 * not by the feature's fields) and `settings-registry.ts` lists the descriptor, which is how the registry
 * knows who owns a key and which keys only main may write. A `*-settings.ts` file that exports no descriptor,
 * or a descriptor the registry does not list, fails `settings-registry.test.ts`.
 *
 * Rules a module follows:
 *   - every key has a zod default, so an older file that lacks it loads with today's value;
 *   - adding a key is additive; renaming or removing one needs a migration in settings-migrations.ts;
 *   - keys that only main may write are named in `mainOnlyKeys` (settings:set strips them from renderer patches).
 */
import type { z } from 'zod'

export interface SettingsFeatureModule {
  readonly id: string
  readonly shape: z.ZodRawShape
  readonly mainOnlyKeys: readonly string[]
}

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function defineSettingsFeature<S extends z.ZodRawShape>(definition: {
  id: string
  shape: S
  mainOnlyKeys?: readonly (keyof S & string)[]
}): SettingsFeatureModule & { readonly shape: S; readonly mainOnlyKeys: readonly (keyof S & string)[] } {
  if (!KEBAB_ID.test(definition.id)) throw new Error(`Settings feature id "${definition.id}" must be kebab-case`)
  const mainOnlyKeys = definition.mainOnlyKeys ?? []
  for (const key of mainOnlyKeys) {
    if (!Object.hasOwn(definition.shape, key))
      throw new Error(`Settings feature "${definition.id}" marks "${key}" main-only but does not declare it`)
  }
  return Object.freeze({ id: definition.id, shape: definition.shape, mainOnlyKeys: Object.freeze([...mainOnlyKeys]) })
}
