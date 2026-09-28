import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ATTRIBUTABLE_PROCESS_KINDS } from './lib.mjs'

const SYNTHETIC_STARTED_AT = Date.UTC(2026, 8, 27, 13, 0, 0)
const SYNTHETIC_MEETINGS = [
  {
    file: '2026-09-27_130000-synthetic-local-routing.md',
    title: 'Synthetic local routing',
    mode: 'meeting',
    durationMin: 34,
    lines: [
      ['them', 'Speaker 1', 'Can we confirm the local model path before the release gate starts?'],
      ['you', 'Operator', 'Yes, the candidate must keep local suggestions and summaries warm on the QA profile.'],
      ['them', 'Speaker 2', 'Please keep the transcript long enough for recall and recap indexing.'],
      ['you', 'Operator', 'We will include action items, decisions, and open questions in the synthetic corpus.']
    ]
  },
  {
    file: '2026-09-27_134500-synthetic-asr-sidecars.md',
    title: 'Synthetic ASR sidecars',
    mode: 'meeting',
    durationMin: 28,
    lines: [
      ['them', 'Speaker 1', 'The profile should exercise local transcription, speaker labeling, and post-meeting recap paths.'],
      ['you', 'Operator', 'Agreed. It must be disposable, content-free, and representative enough for process census work.'],
      ['them', 'Speaker 2', 'Capture the expected sidecar population without using a real cloud-file provider account.']
    ]
  }
]

export function representativeSettings(profileDir, now = Date.now()) {
  const root = resolve(profileDir)
  const meetingsFolder = join(root, 'meetings')
  return {
    onboardingDone: true,
    onboardingDoneAt: now,
    recordingConsent: true,
    meetingsFolder,
    teamTranscriptFolders: [],
    autoSaveTranscripts: true,
    showLiveTranscript: true,
    overlayLayout: 'bar',
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

function brainIndex(meetingsFolder, now) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    source: 'resource-census-representative-synthetic-profile',
    meetingsFolder,
    documents: SYNTHETIC_MEETINGS.map((meeting, index) => ({
      file: meeting.file,
      title: meeting.title,
      kind: 'meeting-transcript',
      startedAt: SYNTHETIC_STARTED_AT + index * 45 * 60_000,
      speakers: [...new Set(meeting.lines.map((line) => line[1]))]
    }))
  }
}

export function writeRepresentativeProfile(profileDir, now = Date.now()) {
  const root = resolve(profileDir)
  const settings = representativeSettings(root, now)
  const brainDir = join(settings.meetingsFolder, '.brain')
  mkdirSync(brainDir, { recursive: true })
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  const meetings = []
  for (const [index, meeting] of SYNTHETIC_MEETINGS.entries()) {
    const startedAt = SYNTHETIC_STARTED_AT + index * 45 * 60_000
    const path = join(settings.meetingsFolder, meeting.file)
    writeFileSync(path, meetingMarkdown(meeting, startedAt), { mode: 0o600 })
    meetings.push({ ...meeting, path, startedAt })
  }
  writeFileSync(join(settings.meetingsFolder, 'index.md'), meetings.map((meeting) => `- [[${meeting.file}|${meeting.title}]]`).join('\n') + '\n')
  writeFileSync(join(brainDir, 'index.json'), `${JSON.stringify(brainIndex(settings.meetingsFolder, now), null, 2)}\n`, { mode: 0o600 })
  const manifest = {
    schemaVersion: 1,
    profileKind: 'representative-synthetic',
    generatedAt: new Date(now).toISOString(),
    settingsFile: join(root, 'settings.json'),
    meetingsFolder: settings.meetingsFolder,
    meetings: meetings.map(({ file, title, startedAt }) => ({ file, title, startedAt })),
    expectedPopulationHints: ATTRIBUTABLE_PROCESS_KINDS
  }
  writeFileSync(join(root, 'resource-census-profile.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { profileDir: root, meetingsFolder: settings.meetingsFolder, settings, meetings, manifest }
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
