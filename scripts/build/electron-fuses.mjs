#!/usr/bin/env node
/**
 * Electron fuses of a packaged Métis (M2-0558).
 *
 * `check` reads the fuse wire out of a packaged app (Metis.app → its Electron Framework binary, Metis.exe →
 * the executable itself) and compares every fuse the electron-builder config declares (`electronFuses`,
 * following `extends` the way electron-builder does: resolved against the project directory, later files
 * override earlier keys) with the bytes actually shipped. A universal macOS binary carries one wire per
 * slice; every slice must match. It writes a content-free JSON report to --out (default out/electron-fuses)
 * and exits 1 on any difference, 2 when the app or config cannot be read.
 *
 * `set` changes one fuse on an INSTALLED harness copy only (packaged-smoke and the History design capture
 * drive main through `--inspect`). It never runs inside a packaging chain, so no shipped byte depends on it.
 * A macOS copy must be re-signed afterwards: the change invalidates the framework's signature.
 *
 * Usage:
 *   node scripts/build/electron-fuses.mjs check <Metis.app|Metis.exe> --config <electron-builder yml> [--out <dir>]
 *   node scripts/build/electron-fuses.mjs set <installed Metis.app|Metis.exe> <fuseKey>=<true|false>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Electron's fuse wire: this sentinel, a version byte (1), a length byte, then one state byte per fuse.
export const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
// Wire order of fuse version 1 (upstream FuseV1Options), named as electron-builder's `electronFuses` keys.
export const FUSE_KEYS = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges'
]
const OFF = 0x30
const ON = 0x31
const REMOVED = 0x72
const STATE_NAMES = { [OFF]: 'off', [ON]: 'on', [REMOVED]: 'removed' }

export function fuseBinaryPath(app) {
  return app.endsWith('.app')
    ? join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
    : app
}

function wireOffsets(binary) {
  const offsets = []
  for (let at = binary.indexOf(SENTINEL); at !== -1; at = binary.indexOf(SENTINEL, at + SENTINEL.length)) {
    const offset = at + SENTINEL.length
    if (binary[offset] !== 1) throw new Error(`unsupported fuse wire version ${binary[offset]}`)
    if (offset + 2 + binary[offset + 1] > binary.length) throw new Error('truncated fuse wire')
    offsets.push(offset)
  }
  if (offsets.length === 0) throw new Error('no Electron fuse wire in this binary')
  return offsets
}

/** One entry per wire (per slice of a universal binary): each known fuse as on, off, removed or absent. */
export function readFuseWires(binary) {
  return wireOffsets(binary).map((offset) => {
    const length = binary[offset + 1]
    const fuses = {}
    FUSE_KEYS.forEach((key, index) => {
      const state = binary[offset + 2 + index]
      const name = STATE_NAMES[state] ?? `unknown(${state})`
      fuses[key] = index >= length ? 'absent' : name
    })
    return { version: binary[offset], length, fuses }
  })
}

/** Sets `key` on every wire of `binary` in place. A removed or absent fuse cannot be set. */
export function setFuse(binary, key, enabled) {
  const index = FUSE_KEYS.indexOf(key)
  if (index === -1) throw new Error(`unknown fuse ${key}`)
  for (const offset of wireOffsets(binary)) {
    if (index >= binary[offset + 1] || binary[offset + 2 + index] === REMOVED) {
      throw new Error(`fuse ${key} is not present in this binary`)
    }
    binary[offset + 2 + index] = enabled ? ON : OFF
  }
}

/**
 * Writes `<name><suffix>.exe` beside a Windows executable with one fuse changed, and returns its path. Beside it,
 * the copy loads the same resources/app.asar and carries the same embedded asar integrity resource, so it differs
 * from the shipped executable by that one fuse byte. The shipped executable is never modified; the caller deletes
 * the copy.
 */
export function harnessCopy(executable, key, enabled, suffix) {
  if (!/\.exe$/i.test(executable)) throw new Error(`harnessCopy takes a Windows .exe, got ${executable}`)
  const copy = executable.replace(/\.exe$/i, `${suffix}.exe`)
  const binary = readFileSync(executable)
  setFuse(binary, key, enabled)
  writeFileSync(copy, binary)
  return copy
}

/**
 * The top-level `extends` and `electronFuses` of one electron-builder YAML file. Only the block form
 * (`electronFuses:` then indented `key: true|false` lines) is accepted; anything else in that block throws
 * rather than being silently skipped, so the declared state can never be misread as "nothing declared".
 */
export function parseBuilderConfig(text, file) {
  let extendsPath = null
  const fuses = {}
  let inFuses = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      inFuses = top[1] === 'electronFuses'
      if (inFuses && top[2] !== '') throw new Error(`${file}: electronFuses must be a block of "key: true|false" lines`)
      if (top[1] === 'extends') extendsPath = top[2].replace(/^(['"])(.*)\1$/, '$2')
      continue
    }
    if (!inFuses) continue
    const entry = /^\s+([A-Za-z]+):\s*(true|false)$/.exec(line)
    if (!entry || !FUSE_KEYS.includes(entry[1])) {
      throw new Error(`${file}: unsupported electronFuses line "${raw.trim()}"`)
    }
    fuses[entry[1]] = entry[2] === 'true'
  }
  return { extendsPath, fuses }
}

/** The fuse state a config declares after its whole `extends` chain is merged. */
export function declaredFuses(
  configPath,
  { projectDir = REPO_ROOT, readFile = (path) => readFileSync(path, 'utf8') } = {}
) {
  const layers = []
  const seen = new Set()
  for (let file = resolve(projectDir, configPath); file !== null; ) {
    if (seen.has(file)) throw new Error(`extends cycle through ${file}`)
    seen.add(file)
    const { extendsPath, fuses } = parseBuilderConfig(readFile(file), file)
    layers.unshift(fuses)
    file = extendsPath === null ? null : resolve(projectDir, extendsPath)
  }
  return Object.assign({}, ...layers)
}

export function fuseMismatches(wires, declared) {
  const mismatches = []
  wires.forEach((wire, slice) => {
    for (const [fuse, enabled] of Object.entries(declared)) {
      const expected = enabled ? 'on' : 'off'
      if (wire.fuses[fuse] !== expected) mismatches.push({ slice, fuse, declared: expected, actual: wire.fuses[fuse] })
    }
  })
  return mismatches
}

/** electron-builder `electronFuses` → the @electron/fuses config `packager.addElectronFuses` takes. */
export function flipFusesConfig(electronFuses) {
  const config = { version: '1' }
  FUSE_KEYS.forEach((key, index) => {
    if (typeof electronFuses[key] === 'boolean') config[index] = electronFuses[key]
  })
  return config
}

function usage(message) {
  console.error(`electron-fuses: ${message}`)
  console.error('usage: electron-fuses.mjs check <app> --config <yml> [--out <dir>] | set <app> <fuseKey>=<true|false>')
  return 2
}

export function runCheck(argv, { projectDir = REPO_ROOT } = {}) {
  let app = null
  let config = null
  let out = join('out', 'electron-fuses')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') config = argv[++i] ?? null
    else if (argv[i] === '--out') out = argv[++i] ?? null
    else if (app === null) app = argv[i]
    else return usage(`unexpected argument ${argv[i]}`)
  }
  if (!app || !config || !out) return usage('check needs an app, --config and a non-empty --out')
  let declared
  let wires
  try {
    declared = declaredFuses(config, { projectDir })
    if (Object.keys(declared).length === 0) throw new Error(`${config} declares no electronFuses`)
    wires = readFuseWires(readFileSync(fuseBinaryPath(app)))
  } catch (error) {
    return usage(error.message)
  }
  const mismatches = fuseMismatches(wires, declared)
  const verdict = mismatches.length === 0 ? 'PASS' : 'FAIL'
  const report = { tool: 'electron-fuses', app, config, declared, wires, mismatches, verdict }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'electron-fuses.json'), `${JSON.stringify(report, null, 2)}\n`)
  for (const [fuse, enabled] of Object.entries(declared)) {
    const shipped = wires.map((wire) => wire.fuses[fuse]).join('/')
    console.log(`${fuse}: declared ${enabled ? 'on' : 'off'}, shipped ${shipped}`)
  }
  for (const { slice, fuse, actual, declared: expected } of mismatches) {
    console.error(`::error::${app} slice ${slice}: ${fuse} is ${actual}, ${config} declares ${expected}`)
  }
  return mismatches.length === 0 ? 0 : 1
}

export function runSet(argv) {
  const [app, assignment, extra] = argv
  const match = /^([A-Za-z]+)=(true|false)$/.exec(assignment ?? '')
  if (!app || !match || extra !== undefined) return usage('set needs an app and one fuseKey=true|false')
  const path = fuseBinaryPath(app)
  try {
    const binary = readFileSync(path)
    setFuse(binary, match[1], match[2] === 'true')
    writeFileSync(path, binary)
  } catch (error) {
    return usage(error.message)
  }
  console.log(`${app}: ${match[1]} set ${match[2] === 'true' ? 'on' : 'off'} (harness copy)`)
  return 0
}

export function main(argv) {
  const [command, ...rest] = argv
  if (command === 'check') return runCheck(rest)
  if (command === 'set') return runSet(rest)
  return usage(`unknown command ${command ?? '(none)'}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
