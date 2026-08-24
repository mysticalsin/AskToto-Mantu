#!/usr/bin/env node
/**
 * Refuse to package for a platform this host cannot physically test.
 *
 * The Windows chain does not merely cross-compile: it EXECUTES the artefact it just built.
 * check-packaged-launch.mjs starts release/win-unpacked/Metis.exe on a clean profile and waits for a real
 * window, and check-packaged-asr.mjs drives that same running app through a real Parakeet decode of real
 * audio. Neither can run anywhere but Windows.
 *
 * Without this guard those gates are what fails, several minutes in, with an error about a missing binary
 * or a window that never appeared — which reads like a broken build rather than "you are on the wrong
 * machine". Worse, a chain that skipped them would happily emit an installer nobody ever launched, and an
 * unlaunched installer is exactly how a bytecode/runtime mismatch ships (the 1.2.0 Windows exe was DOA on
 * launch for precisely that reason).
 *
 * So the rule is deliberately strict: the .exe is built only on Windows, where the build itself proves it
 * starts. There is no override flag — an escape hatch here would be used exactly once, in a hurry, to ship
 * the thing this exists to prevent.
 *
 * Usage: node scripts/check-build-host.mjs <win|mac|linux>
 */
const TARGETS = {
  win: {
    platform: 'win32',
    label: 'Windows',
    proof: 'check-packaged-launch.mjs (starts the .exe and waits for its window) and check-packaged-asr.mjs (decodes real audio through the packaged Parakeet engine)'
  },
  mac: {
    platform: 'darwin',
    label: 'macOS',
    proof: 'codesign/notarisation and the packaged launch check, none of which exist off macOS'
  },
  linux: { platform: 'linux', label: 'Linux', proof: 'the packaged launch check' }
}

const target = process.argv[2]
const spec = TARGETS[target]

if (!spec) {
  console.error(`[check:build-host] unknown target ${JSON.stringify(target)}. Expected one of: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}

if (process.platform !== spec.platform) {
  console.error(
    `[check:build-host] REFUSED — cannot build the ${spec.label} package on ${process.platform}.\n` +
      `\n` +
      `  This chain physically runs what it builds: ${spec.proof}.\n` +
      `  Those gates are the reason a shipped installer is known to start at all, so packaging on a host\n` +
      `  that cannot execute the artefact would produce an installer nobody has ever launched.\n` +
      `\n` +
      `  Build ${target} on a ${spec.label} machine.`
  )
  process.exit(1)
}

console.log(`[check:build-host] OK — building ${target} on ${spec.label} (${process.platform}), where the packaged app can be launched and tested.`)
