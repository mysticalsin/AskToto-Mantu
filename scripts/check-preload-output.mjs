import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const preloadDir = join(process.cwd(), 'out', 'preload')
const expectedEntries = ['index.js', 'intelligence.js', 'import-decoder.js']

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

if (!existsSync(preloadDir)) {
  fail('Missing out/preload. Run npm run build before check:preload-output.')
} else {
  const chunksDir = join(preloadDir, 'chunks')
  if (existsSync(chunksDir)) {
    fail('Preload build produced out/preload/chunks. Each preload entry must be standalone.')
  }

  for (const entry of expectedEntries) {
    const file = join(preloadDir, entry)
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`Missing preload output: out/preload/${entry}`)
      continue
    }

    const source = readFileSync(file, 'utf8')
    if (/\brequire\s*\(\s*['"]\.\.?\//.test(source)) {
      fail(`Preload output contains a relative require(): out/preload/${entry}`)
    }
  }

  for (const name of readdirSync(preloadDir)) {
    const file = join(preloadDir, name)
    if (!name.endsWith('.js') || !statSync(file).isFile()) continue
    const source = readFileSync(file, 'utf8')
    if (/\brequire\s*\(\s*['"]\.\.?\//.test(source)) {
      fail(`Preload output contains a relative require(): out/preload/${name}`)
    }
  }
}
