import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAIRS = [
  [
    'src/shared/contracts/transcript/__fixtures__',
    'native-app/MetisKit/Tests/MetisKitTests/Fixtures/contracts/transcript'
  ]
]

for (const [sourcePath, targetPath] of PAIRS) {
  const source = resolve(ROOT, sourcePath)
  const target = resolve(ROOT, targetPath)
  if (!existsSync(source)) {
    throw new Error(`Contract fixture source does not exist: ${sourcePath}`)
  }
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
}
