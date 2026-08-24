#!/usr/bin/env node
/**
 * provision-mac-natives.mjs — install BOTH mac arches of every prebuilt native addon in a SINGLE
 * npm install, for the universal mac package.
 *
 * WHY ONE COMMAND, AND WHY A SCRIPT AT ALL
 * These addons are `--no-save` installs: they are not in package.json (npm's own os/cpu gating would
 * only ever install the host arch, and a universal .app needs both). npm treats a `--no-save --force`
 * install as a full tree re-resolution, so it PRUNES every other package that is not in package.json.
 * Chaining the provisioning steps therefore cannot work — each one deletes the previous one's output:
 *
 *   check-sherpa (installs sherpa x64)  ->  sharp install  ->  sherpa x64 is gone
 *   sharp install                       ->  check-sherpa   ->  sharp x64 is gone
 *
 * Both orders were observed. The only arrangement where all of them survive is one install listing
 * every package at once, which is what this script does. The check-* guards then merely VERIFY.
 *
 * The arm64 packages are listed explicitly even though a normal `npm ci` on an Apple Silicon host
 * already installs them: this command re-resolves the tree, so omitting them would prune the very
 * arch the build machine runs on.
 *
 * A missing addon does not fail the build loudly on its own — it silently ships an app that falls
 * back (Parakeet ASR -> Whisper) or throws at runtime on one architecture only. check-sherpa-platform
 * .mjs and the packaged-runtime guard are what turn that into a build-time failure; this script is
 * what makes them pass.
 *
 * Usage: node scripts/provision-mac-natives.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Pin to the versions already resolved in node_modules so this can never drift from the lockfile. */
function installedVersion(pkgName) {
  const p = join(REPO_ROOT, 'node_modules', pkgName, 'package.json')
  if (!existsSync(p)) {
    throw new Error(
      `${pkgName} is not installed, so its version cannot be pinned. Run \`npm ci\` before provisioning mac natives.`
    )
  }
  return JSON.parse(readFileSync(p, 'utf8')).version
}

const sherpaVersion = installedVersion('sherpa-onnx-node')
const sharpVersion = installedVersion('sharp')
// libvips is sharp's own prebuilt dependency; its version tracks sharp's and is read from the arch
// package sharp already pulled in for the host rather than hardcoded a second time.
const libvipsVersion = installedVersion(
  process.arch === 'arm64' ? '@img/sharp-libvips-darwin-arm64' : '@img/sharp-libvips-darwin-x64'
)

const packages = [
  `sherpa-onnx-darwin-arm64@${sherpaVersion}`,
  `sherpa-onnx-darwin-x64@${sherpaVersion}`,
  `@img/sharp-darwin-arm64@${sharpVersion}`,
  `@img/sharp-darwin-x64@${sharpVersion}`,
  `@img/sharp-libvips-darwin-arm64@${libvipsVersion}`,
  `@img/sharp-libvips-darwin-x64@${libvipsVersion}`
]

console.log('=== provision-mac-natives: both mac arches, one install ===')
for (const p of packages) console.log(`  · ${p}`)

// --force is required: npm refuses a package whose `cpu` field does not match the host, which is
// exactly the cross-arch half of a universal build. Every one of these ships a prebuilt binary, so
// nothing is compiled here.
execFileSync('npm', ['install', '--no-save', '--force', ...packages], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

// Prove the install produced every addon rather than trusting npm's exit code — `--force` downgrades
// a genuine resolution failure to a warning, and the packaged app would then be missing an arch.
const required = ['sherpa-onnx-darwin-arm64/sherpa-onnx.node', 'sherpa-onnx-darwin-x64/sherpa-onnx.node']

// sharp bakes its own version into the prebuilt addon's FILENAME — @img/sharp-darwin-arm64 ships
// lib/sharp-darwin-arm64-0.35.3.node, not lib/sharp-darwin-arm64.node. An exact-filename check
// therefore breaks on every sharp bump even though the install succeeded, and it did exactly that
// when the sharp CVE fix moved the pin to 0.35.3: predist died with "missing after install" and no
// macOS DMG could be built at all. Match the addon by prefix + extension instead. This is not a
// weakening — the gate still proves an addon for BOTH arches is physically present, which is the
// whole point (npm install --force downgrades a real resolution failure to a warning); it just
// stops asserting a filename npm owns and changes without notice.
const sharpAddons = ['arm64', 'x64'].map((arch) => ({
  label: `@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}*.node`,
  dir: join(REPO_ROOT, 'node_modules', '@img', `sharp-darwin-${arch}`, 'lib'),
  prefix: `sharp-darwin-${arch}`
}))

const missing = [
  ...required.filter((r) => !existsSync(join(REPO_ROOT, 'node_modules', r))),
  ...sharpAddons
    .filter(
      (a) =>
        !existsSync(a.dir) ||
        !readdirSync(a.dir).some((f) => f.startsWith(a.prefix) && f.endsWith('.node'))
    )
    .map((a) => a.label)
]
if (missing.length) {
  console.error(
    `\nprovision-mac-natives FAILED — missing after install:\n${missing.map((m) => `  ✗ ${m}`).join('\n')}\n` +
      'A universal package built from here would be broken on one architecture.'
  )
  process.exit(1)
}
console.log('=== provision-mac-natives complete — both arches present ===')
