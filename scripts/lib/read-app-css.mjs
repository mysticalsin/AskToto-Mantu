// Reads the renderer stylesheet as one string in cascade order: styles.css with every local
// `@import './x.css'` replaced by that file's contents (recursively). Contract tests assert on rules
// regardless of which feature stylesheet holds them, so splitting styles.css never changes what they see.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_IMPORT = /^@import\s+['"](\.[^'"]+)['"];[ \t]*$/gm
const RENDERER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'src')

function inline(file) {
  const css = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  return css.replace(LOCAL_IMPORT, (_match, target) => inline(join(dirname(file), target)))
}

export function readAppCss() {
  return inline(join(RENDERER_SRC, 'styles.css'))
}
