#!/usr/bin/env node
import { extractFile, listPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptProxyKey, isEncryptedBlob } from './lib/embedded-cloudflare-crypto.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const outputDirectory = process.argv[2]
if (!outputDirectory) {
  throw new Error('Usage: node scripts/check-cahe-package.mjs <output-directory>')
}

const outputRoot = resolve(outputDirectory)
const installerPattern = /^Metis-Windows-Cahe-Setup-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\.exe$/
const installers = readdirSync(outputRoot).filter((name) => installerPattern.test(name))
if (installers.length !== 1) {
  throw new Error(`Expected exactly one Cahê installer, found: ${installers.join(', ') || 'none'}`)
}

const installer = join(outputRoot, installers[0])
if (!statSync(installer).isFile() || statSync(installer).size === 0) {
  throw new Error(`Cahê installer is missing or empty: ${installer}`)
}

const executable = join(outputRoot, 'win-unpacked', 'Metis-Windows-Cahe.exe')
if (!existsSync(executable) || statSync(executable).size === 0) {
  throw new Error(`Cahê executable is missing or empty: ${executable}`)
}

const appAsar = join(outputRoot, 'win-unpacked', 'resources', 'app.asar')
const sourceMainLoader = readFileSync(join(repositoryRoot, 'out/main/index.js'))
const sourceMainBytecode = readFileSync(join(repositoryRoot, 'out/main/index.jsc'))
const extractPackaged = (posixPath) => {
  const wanted = `/${posixPath.replace(/^\/+/, '')}`
  const rawKey = listPackage(appAsar).find(
    (entry) => `/${entry.split('\\').join('/').replace(/^\/+/, '')}` === wanted
  )
  if (!rawKey) throw new Error(`Cahê package is missing ${posixPath}`)
  return extractFile(appAsar, rawKey.replace(/^[\\/]+/, ''))
}
const packagedMainLoader = extractPackaged('out/main/index.js')
const packagedMainBytecode = extractPackaged('out/main/index.jsc')

if (!packagedMainLoader.toString('utf8').includes('require("./index.jsc")')) {
  throw new Error('Cahê package does not contain the bytecode main-process loader')
}
if (!packagedMainLoader.equals(sourceMainLoader)) {
  throw new Error('Cahê package main-process loader differs from the just-built source loader')
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
if (sha256(packagedMainBytecode) !== sha256(sourceMainBytecode)) {
  throw new Error('Cahê package main-process bytecode differs from the just-built source bytecode')
}

const kimiKeyPattern = /sk-kimi-[A-Za-z0-9_-]{16,}/
const ALLOW_EMBEDDED_KIMI_KEY = process.env.METIS_CAHE_EMBED_KEY === '1'
const localEmbed = join(repositoryRoot, 'build', 'cahe-embed', 'kimi.json')
const embedIntended = existsSync(localEmbed) && statSync(localEmbed).size > 0

function requireEncryptedBlob(path, label) {
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`${label}: missing or empty (${path})`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${label}: not readable JSON (${path}): ${e.message}`)
  }
  if (parsed && typeof parsed === 'object' && 'kimiApiKey' in parsed) {
    throw new Error(
      `${label}: carries a plaintext "kimiApiKey" field (${path}). The embedded Cahê key must ship ENCRYPTED — ` +
        're-run scripts/embed-cahe-kimi-key.mjs, which writes the ciphertext blob.'
    )
  }
  if (!isEncryptedBlob(parsed)) {
    throw new Error(`${label}: is not the expected AES-256-GCM blob shape (ciphertext/iv/tag/salt) at ${path}`)
  }
  return parsed
}

async function assertNoPlaintextKimiToken(path, token) {
  await new Promise((resolvePromise, rejectPromise) => {
    let carry = ''
    const stream = createReadStream(path)
    stream.on('data', (chunk) => {
      const text = carry + chunk.toString('latin1')
      if (token ? text.includes(token) : kimiKeyPattern.test(text)) {
        stream.destroy(
          new Error(
            token
              ? `PLAINTEXT LEAK — Cahê Kimi token found in cleartext in ${basename(path)}`
              : `Refusing Cahê package with an embedded Kimi API key: ${basename(path)}`
          )
        )
        return
      }
      carry = text.slice(-64)
    })
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
}

const packagedCaheResources = join(outputRoot, 'win-unpacked', 'resources', 'cahe')
const packagedKimi = join(packagedCaheResources, 'kimi.json')

if (embedIntended) {
  if (!ALLOW_EMBEDDED_KIMI_KEY) {
    throw new Error(
      'build/cahe-embed/kimi.json is present but METIS_CAHE_EMBED_KEY=1 was not set — refusing to package an ' +
        'embedded Cahê Kimi key without the explicit opt-in.'
    )
  }
  requireEncryptedBlob(localEmbed, 'build/cahe-embed/kimi.json')
  if (!existsSync(packagedKimi)) {
    throw new Error(`Expected packaged resources/cahe/kimi.json under ${outputRoot}`)
  }
  const packagedBlob = requireEncryptedBlob(packagedKimi, 'packaged cahe/kimi.json')
  let token
  try {
    token = decryptProxyKey(packagedBlob)
  } catch (e) {
    throw new Error(`packaged cahe/kimi.json could not be decrypted with the shipped material: ${e.message}`)
  }
  if (!kimiKeyPattern.test(token)) {
    throw new Error('packaged cahe/kimi.json decrypted to something that is not a usable sk-kimi- key')
  }
  // Prove plaintext does not appear in app.asar, installer, or cahe resources.
  await assertNoPlaintextKimiToken(appAsar, token)
  await assertNoPlaintextKimiToken(installer, token)
  if (existsSync(packagedCaheResources)) {
    for (const entry of readdirSync(packagedCaheResources, { recursive: true })) {
      const file = join(packagedCaheResources, entry)
      if (statSync(file).isFile()) await assertNoPlaintextKimiToken(file, token)
    }
  }
  console.log(`
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
⚠️  Cahê build intentionally embeds a Kimi API key. It ships ENCRYPTED (AES-256-GCM), but that is
⚠️  OBFUSCATION, not secrecy — the decryption material ships in the app, so the key is still
⚠️  EXTRACTABLE with effort. Scope/rotate that key. Expected ONLY because METIS_CAHE_EMBED_KEY=1.
⚠️  Found encrypted blob: ${basename(packagedKimi)}
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
`)
  console.log(
    `[check:cahe-package] OK ${installers[0]} — current bytecode, distinct identity, encrypted Cahê Kimi key explicitly allowed (METIS_CAHE_EMBED_KEY=1); no plaintext token in package`
  )
} else {
  // Keyless: refuse any sk-kimi- leak and any leftover kimi.json (plaintext or encrypted stale).
  await assertNoPlaintextKimiToken(appAsar)
  await assertNoPlaintextKimiToken(installer)
  if (existsSync(packagedKimi) && statSync(packagedKimi).size > 0) {
    throw new Error(`No local cahe-embed/kimi.json to embed, but the package still carries one at ${packagedKimi}`)
  }
  if (existsSync(packagedCaheResources)) {
    for (const entry of readdirSync(packagedCaheResources, { recursive: true })) {
      const file = join(packagedCaheResources, entry)
      if (statSync(file).isFile()) await assertNoPlaintextKimiToken(file)
    }
  }
  console.log(`[check:cahe-package] OK ${installers[0]} — current bytecode, distinct identity, no embedded Kimi key`)
}
