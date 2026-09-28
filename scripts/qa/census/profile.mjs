import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function representativeSettings(profileDir, now = Date.now()) {
  const root = resolve(profileDir)
  const meetingsFolder = join(root, 'meetings')
  return {
    onboardingDone: true,
    onboardingDoneAt: now,
    recordingConsent: true,
    meetingsFolder,
    autoSaveTranscripts: true,
    overlayLayout: 'bar',
    overlayOrbStyle: 'obsidian',
    localLlm: {
      enabled: true,
      modelId: 'qwen3.5-0.8b',
      useFor: { suggest: true, summary: true, vision: true },
      fallback: true
    },
    routingMode: 'local'
  }
}

export function writeRepresentativeProfile(profileDir, now = Date.now()) {
  const root = resolve(profileDir)
  const settings = representativeSettings(root, now)
  mkdirSync(settings.meetingsFolder, { recursive: true })
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  return { profileDir: root, meetingsFolder: settings.meetingsFolder, settings }
}

function usage() {
  return 'Usage: node scripts/qa/census/profile.mjs <profile-dir>'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const profileDir = process.argv[2]
  if (!profileDir) {
    console.error(usage())
    process.exit(2)
  }
  const profile = writeRepresentativeProfile(profileDir)
  console.log(`[census-profile] wrote ${profile.profileDir}`)
}
