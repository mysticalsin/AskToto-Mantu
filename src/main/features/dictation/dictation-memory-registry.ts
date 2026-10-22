/**
 * The one dictation memory of this process (G26), installed by the owner-session wiring (which holds the verified
 * owner, the userData path and the IPC authorizer) and read by the dictation runtime on every use. The runtime is
 * built before that wiring exists, so it resolves the memory lazily instead of holding it. Null until installed, and
 * after a test resets it: a runtime with no memory dictates exactly as before and journals nothing.
 */
import type { DictationMemory } from './dictation-memory'

let installed: DictationMemory | null = null

export function installDictationMemory(memory: DictationMemory | null): void {
  installed = memory
}

export function currentDictationMemory(): DictationMemory | null {
  return installed
}
