import { createHash } from 'node:crypto'
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SYNTHETIC_STARTED_AT = Date.UTC(2026, 8, 27, 13, 0, 0)
const SYNTHETIC_MEETING_COUNT = 59
const PROFILE_SCHEMA_VERSION = 2
const BRAIN_SCHEMA_VERSION = 2
const ALLOWED_LAYOUTS = new Set(['bar', 'hide'])
const DATALESS_REASON = 'real dataless files need a cloud provider; measured in the owner soak (OD-36)'

const SUBJECTS = [
  'local routing',
  'recall indexing',
  'history filtering',
  'summary review',
  'speaker labeling',
  'sidecar startup',
  'settings restore',
  'overlay parking',
  'capture recovery',
  'backfill pacing',
  'brain status',
  'resource sampling'
]
const OUTCOMES = [
  'keep the hosted census comparable',
  'avoid a fresh-profile measurement',
  'exercise the settled idle path',
  'leave the transcript store portable',
  'confirm the index is already covered',
  'record a repeatable synthetic workload'
]
const CONCERNS = [
  'cold launch should not invent extra work',
  'local inference must stay enabled',
  'speaker labels should remain stable',
  'the meeting mode should stay explicit',
  'synthetic notes must avoid personal data',
  'cloud-only placeholders are measured elsewhere'
]

function seededRandom(seed = 48_900_007) {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function validateLayout(layout) {
  if (!ALLOWED_LAYOUTS.has(layout)) throw new Error(`layout must be one of: ${[...ALLOWED_LAYOUTS].join(', ')}`)
  return layout
}

function syntheticMeetings() {
  const random = seededRandom()
  const spanMs = 90 * 24 * 60 * 60_000
  return Array.from({ length: SYNTHETIC_MEETING_COUNT }, (_, index) => {
    const jitterMs = Math.floor(random() * 4 * 60 * 60_000)
    const bucketMs = spanMs / (SYNTHETIC_MEETING_COUNT + 1)
    const startedAt = SYNTHETIC_STARTED_AT - spanMs + Math.floor((index + 1) * bucketMs) + jitterMs
    const durationMin = 5 + Math.floor(random() * 86)
    const subject = SUBJECTS[index % SUBJECTS.length]
    const outcome = OUTCOMES[(index + 2) % OUTCOMES.length]
    const concern = CONCERNS[(index + 4) % CONCERNS.length]
    const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    return {
      file: `${stamp.slice(0, 8)}_${stamp.slice(9, 15)}-synthetic-census-${String(index + 1).padStart(2, '0')}.md`,
      title: `Synthetic census meeting ${String(index + 1).padStart(2, '0')}`,
      mode: 'meeting',
      durationMin,
      startedAt,
      lines: [
        ['them', 'Speaker 1', `This synthetic meeting checks ${subject} for the representative profile.`],
        ['you', 'Operator', `The expected outcome is to ${outcome} without using private material.`],
        ['them', 'Speaker 2', `One concern is that ${concern} during the hosted run.`],
        ['you', 'Operator', `We will keep mode meeting, local routing, speaker identification, and Whisper active.`],
        ['them', 'Speaker 1', `The generated brain index should already cover this transcript before launch.`],
        ['you', 'Operator', `Action item: compare the census output against the same deterministic profile digest.`]
      ]
    }
  })
}

const SYNTHETIC_MEETINGS = syntheticMeetings()

export function representativeSettings(profileDir, now = SYNTHETIC_STARTED_AT, options = {}) {
  const root = resolve(profileDir)
  const meetingsFolder = join(root, 'meetings')
  const layout = validateLayout(options.layout ?? 'bar')
  return {
    onboardingDone: true,
    onboardingDoneAt: now,
    recordingConsent: true,
    meetingsFolder,
    teamTranscriptFolders: [],
    autoSaveTranscripts: true,
    showLiveTranscript: true,
    overlayLayout: layout,
    overlayOrbStyle: 'obsidian',
    overlayPlacement: 'right-edge',
    instantSuggestions: true,
    backgroundScreenContext: true,
    asrEngine: 'whisper',
    asrQuality: 'best',
    speakerId: { enabled: true, saveVoiceprints: false },
    localLlm: {
      enabled: true,
      modelId: 'qwen3.5-0.8b',
      useFor: { suggest: true, summary: true, vision: true },
      fallback: true
    },
    brainConsolidation: { enabled: true, maxPassesPerDay: 2, preferLocal: false },
    routingMode: 'local'
  }
}

function yamlString(value) {
  return JSON.stringify(value)
}

function meetingMarkdown(meeting, startedAt) {
  const lines = meeting.lines
    .map(([speaker, name, text], index) => {
      const t = startedAt + index * 45_000
      return `- ${new Date(t).toISOString()} ${name} (${speaker}): ${text}`
    })
    .join('\n')
  return `---
type: meeting-transcript
title: ${yamlString(meeting.title)}
mode: ${yamlString(meeting.mode)}
date: ${yamlString(new Date(startedAt).toISOString())}
duration_min: ${meeting.durationMin}
recap_status: complete
---

# ${meeting.title}

## Notes & follow-ups

Summary: Synthetic QA meeting used to exercise local routing, recall indexing, ASR sidecar discovery, and recap paths.

Decisions:
- Keep local routing enabled for suggestions, summaries, and vision on this disposable profile.

Action items:
- Operator: run the hosted census against the installed packaged app.

## Full transcript

${lines}
`
}

function sourceVersion(path) {
  const stats = statSync(path)
  return `${Math.round(stats.mtimeMs)}:${stats.size}`
}

function brainIndex(meetings, now) {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    ingested: Object.fromEntries(
      meetings.map((meeting) => [
        meeting.file,
        { at: now, ok: true, sourceVersion: sourceVersion(meeting.path), attempts: 0 }
      ])
    ),
    warnings: [],
    backfillRequested: false,
    replayPending: false,
    revision: 0,
    sourceRefreshRequested: false,
    dailyRunDate: '',
    dailyRunCount: 0
  }
}

function transcriptWordCount(meetings) {
  return meetings
    .flatMap((meeting) => meeting.lines.map((line) => line[2]))
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function stableSettingsForDigest(settings) {
  return { ...settings, meetingsFolder: '<profile>/meetings' }
}

function profileDigest(settings, index) {
  return createHash('sha256')
    .update(JSON.stringify({ settings: stableSettingsForDigest(settings), index }))
    .digest('hex')
}

function manifest({ settings, index, meetings }) {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileKind: 'representative-synthetic',
    meetingCount: meetings.length,
    totalTranscriptWords: transcriptWordCount(meetings),
    layout: settings.overlayLayout,
    localLlm: { enabled: settings.localLlm.enabled, modelId: settings.localLlm.modelId },
    brain: { enabled: settings.brainConsolidation.enabled },
    speakerId: { enabled: settings.speakerId.enabled },
    asrEngine: settings.asrEngine,
    datalessMeetings: 0,
    datalessReason: DATALESS_REASON,
    sha256: profileDigest(settings, index)
  }
}

export function writeRepresentativeProfile(profileDir, now = SYNTHETIC_STARTED_AT, options = {}) {
  const root = resolve(profileDir)
  const settings = representativeSettings(root, now, options)
  const brainDir = join(settings.meetingsFolder, '.brain')
  mkdirSync(brainDir, { recursive: true })
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  const meetings = []
  for (const [index, meeting] of SYNTHETIC_MEETINGS.entries()) {
    const startedAt = meeting.startedAt
    const path = join(settings.meetingsFolder, meeting.file)
    writeFileSync(path, meetingMarkdown(meeting, startedAt), { mode: 0o600 })
    utimesSync(path, new Date(startedAt), new Date(startedAt))
    meetings.push({ ...meeting, path, startedAt })
  }
  writeFileSync(join(settings.meetingsFolder, 'index.md'), meetings.map((meeting) => `- [[${meeting.file}|${meeting.title}]]`).join('\n') + '\n')
  const index = brainIndex(meetings, now)
  writeFileSync(join(brainDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
  const profileManifest = manifest({ settings, index, meetings })
  writeFileSync(join(root, 'resource-census-profile.json'), `${JSON.stringify(profileManifest, null, 2)}\n`, { mode: 0o600 })
  return { profileDir: root, meetingsFolder: settings.meetingsFolder, settings, meetings, brainIndex: index, manifest: profileManifest }
}

function usage() {
  return 'Usage: node scripts/qa/census/profile.mjs [--layout bar|hide] <profile-dir>'
}

/** True when this module is the process entry point. `pathToFileURL` yields `file:///D:/...` for a Windows
 *  argv[1], which a hand-built `file://${argv1}` never matches, so the CLI silently wrote nothing there. */
export function isMainModule(metaUrl, argv1, pathOptions) {
  return Boolean(argv1) && metaUrl === pathToFileURL(argv1, pathOptions).href
}

function readArgs(argv) {
  const args = { layout: 'bar', profileDir: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--layout') {
      i += 1
      if (i >= argv.length) throw new Error('--layout requires a value')
      args.layout = validateLayout(argv[i])
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (!args.profileDir) {
      args.profileDir = arg
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = readArgs(process.argv.slice(2))
  if (args.help || !args.profileDir) {
    console.error(usage())
    process.exit(args.help ? 0 : 2)
  }
  const profile = writeRepresentativeProfile(args.profileDir, SYNTHETIC_STARTED_AT, { layout: args.layout })
  console.log(`[census-profile] wrote ${profile.profileDir}`)
  console.log(`[census-profile] manifest ${join(profile.profileDir, 'resource-census-profile.json')}`)
}
