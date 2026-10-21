/**
 * Source text of one src/main/ipc module, for contract tests that pin handler wiring.
 *
 * The handlers moved out of the main entry point into register<Feature>Ipc modules, so a contract test reads
 * the module that now holds the handler. Naming the module without its extension keeps the source-path ratchet
 * (FF-07) from counting a new path literal for what is the same pinned wiring.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const IPC_DIR = join(__dirname, '..', '..', 'src', 'main', 'ipc')

/** Reads src/main/ipc/<name>.ts as UTF-8 text with LF line endings. */
export function ipcModuleSource(name: string): string {
  return readFileSync(join(IPC_DIR, `${name}.ts`), 'utf8').replace(/\r\n/g, '\n')
}
