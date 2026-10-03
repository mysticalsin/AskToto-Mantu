#!/usr/bin/env node
/**
 * CI-only renderer screenshot harness for M2-0408.
 *
 * It creates a temporary Vite app inside the target checkout, renders the six split views with synthetic
 * data, captures light and dark screenshots with Playwright, and writes a manifest for Opus review.
 *
 * Usage:
 *   node scripts/qa/m2-0408-renderer-parity.mjs --repo . --out out/m2-0408-renderer-parity --label after
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const DEFAULT_VIEWS = ['bar', 'review', 'onboarding-experience', 'brain-view', 'recall-view', 'brain-record-page']
const DEFAULT_THEMES = ['light', 'dark']

function parseArgs(argv) {
  const args = { repo: process.cwd(), out: 'out/m2-0408-renderer-parity', label: 'after', views: DEFAULT_VIEWS, themes: DEFAULT_THEMES }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--repo' && next) {
      args.repo = next
      i++
    } else if (arg === '--out' && next) {
      args.out = next
      i++
    } else if (arg === '--label' && next) {
      args.label = next
      i++
    } else if (arg === '--views' && next) {
      args.views = next.split(',').map((v) => v.trim()).filter(Boolean)
      i++
    } else if (arg === '--themes' && next) {
      args.themes = next.split(',').map((v) => v.trim()).filter(Boolean)
      i++
    }
    else throw new Error(`unknown argument: ${arg}`)
  }
  return {
    repo: resolve(args.repo),
    out: resolve(args.out),
    label: args.label,
    views: args.views,
    themes: args.themes
  }
}

function modulePath(repo, options) {
  for (const option of options) {
    const full = resolve(repo, option)
    if (existsSync(full)) return `/@fs/${full}`
  }
  throw new Error(`none of these module paths exist: ${options.join(', ')}`)
}

function writeHarness(repo, out) {
  const harnessDir = resolve(repo, 'out', 'm2-0408-renderer-parity-harness')
  rmSync(harnessDir, { recursive: true, force: true })
  mkdirSync(harnessDir, { recursive: true })
  const src = resolve(harnessDir, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(resolve(harnessDir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" /><title>M2-0408</title></head><body><div id="root"></div><script type="module" src="/src/harness.tsx"></script></body></html>\n')
  writeFileSync(resolve(src, 'harness.tsx'), harnessSource(repo))
  mkdirSync(out, { recursive: true })
  return harnessDir
}

function harnessSource(repo) {
  const imports = {
    styles: `/@fs/${resolve(repo, 'src/renderer/src/styles.css')}`,
    bar: modulePath(repo, ['src/renderer/src/components/Bar.tsx', 'src/renderer/src/features/bar/Bar.tsx']),
    review: modulePath(repo, ['src/renderer/src/components/Review.tsx', 'src/renderer/src/features/review/Review.tsx']),
    onboarding: modulePath(repo, ['src/renderer/src/components/OnboardingExperience.tsx', 'src/renderer/src/features/onboarding-experience/OnboardingExperience.tsx']),
    brain: modulePath(repo, ['src/renderer/src/components/BrainView.tsx', 'src/renderer/src/features/brain-view/BrainView.tsx']),
    recall: modulePath(repo, ['src/renderer/src/components/RecallView.tsx', 'src/renderer/src/features/recall-view/RecallView.tsx']),
    record: modulePath(repo, ['src/renderer/src/components/BrainRecordPage.tsx', 'src/renderer/src/features/brain-record-page/BrainRecordPage.tsx']),
    ipc: `/@fs/${resolve(repo, 'src/shared/ipc.ts')}`
  }
  return `
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'streamdown/styles.css'
import ${JSON.stringify(imports.styles)}
import { DEFAULT_SETTINGS } from ${JSON.stringify(imports.ipc)}
import { Bar } from ${JSON.stringify(imports.bar)}
import { Review } from ${JSON.stringify(imports.review)}
import { OnboardingExperience } from ${JSON.stringify(imports.onboarding)}
import { BrainView } from ${JSON.stringify(imports.brain)}
import { RecallView } from ${JSON.stringify(imports.recall)}
import { BrainRecordPage } from ${JSON.stringify(imports.record)}

const now = Date.parse('2026-10-03T12:00:00Z')
const noop = () => {}
const ok = { ok: true }
const meetingFile = 'synthetic-meeting.md'
const meetings = [
  { file: meetingFile, title: 'Synthetic planning review', date: '2026-10-03T09:00:00Z', mode: 'sales', durationMin: 32, participants: ['Alex', 'Sam'], topics: ['Renewal', 'Timeline'] },
  { file: 'synthetic-follow-up.md', title: 'Follow-up checkpoint', date: '2026-09-28T11:00:00Z', mode: 'meeting', durationMin: 18, participants: ['Mira'] }
]
const field = (value, quote = 'Synthetic source line.') => ({ value, provenance: { state: 'extracted', quote, source_file: meetingFile } })
const brainData = {
  index: { replayError: '', schemaVersion: 1 },
  graph: { nodes: [], edges: [] },
  people: [{
    id: 'person-alex',
    name: 'Alex Morgan',
    role: field('Program lead'),
    org: field('Example Co'),
    meetings: [{ file: meetingFile, title: 'Synthetic planning review', date: '2026-10-03T09:00:00Z' }],
    commitments: [{ text: 'Send the launch brief.', by: 'you', due_hint: 'Friday', quote: 'I will send the launch brief by Friday.', confidence: 'EXTRACTED', meeting: meetingFile, date: '2026-10-03', status: 'open' }]
  }],
  accounts: [{
    id: 'account-example',
    name: 'Example Co',
    sector: 'technology',
    sector_confidence: 'EXTRACTED',
    confidence: 'EXTRACTED',
    meetings: [{ file: meetingFile, title: 'Synthetic planning review', date: '2026-10-03T09:00:00Z' }],
    signals: [{ kind: 'positive', statement: 'Timeline is aligned.', quote: 'The October plan works.', confidence: 'EXTRACTED' }]
  }],
  deals: [{
    id: 'deal-renewal',
    name: 'Example renewal',
    account: 'Example Co',
    stage: 'Review',
    outcome: 'open',
    win_likelihood_band: 'good',
    band_evidence: 'Positive stakeholder signal.',
    velocity: { signal: 'hard-calendar-gate', evidence: 'Decision date stated.' },
    amount: { value: 240000, currency: 'EUR', quote: 'The renewal is 240000 EUR.' },
    close_date: { value: '2026-10-30', quote: 'We close by October 30.' },
    meetings: [{ file: meetingFile, title: 'Synthetic planning review', date: '2026-10-03T09:00:00Z' }],
    commitments: [{ text: 'Confirm procurement owner.', by: 'them', due_hint: 'next week', quote: 'We will confirm the owner next week.', confidence: 'EXTRACTED', meeting: meetingFile, date: '2026-10-03', status: 'open' }]
  }],
  meetings: [{
    source_file: meetingFile,
    date: '2026-10-03T09:00:00Z',
    title24: 'Planning review',
    account: 'Example Co',
    topics: ['Renewal', 'Timeline'],
    sentiment: 'good',
    people: [{ name: 'Alex Morgan', role: 'Program lead', org: 'Example Co', confidence: 'EXTRACTED' }]
  }]
}
const brainStatus = { meetings: 2, ingestedFiles: meetings.map((m) => m.file), people: 1, accounts: 1, deals: 1, nodes: 3, edges: 2, warnings: 0, revision: 1, backfill: { total: 2, done: 2, failed: 0, running: false }, live: { pending: 0, running: false } }
const settings = {
  ...DEFAULT_SETTINGS,
  hasApiKey: true,
  embeddedCloudflareKeyAvailable: false,
  operatorConfigured: false,
  providerReady: true,
  visionReady: true,
  visionAvailable: true,
  localReady: true,
  localSuggestReady: true,
  localSummaryReady: true,
  localVisionReady: true,
  localFallbackReady: false,
  unhealthyProviders: [],
  lastFailover: null,
  managedKeys: [],
  envKeys: [],
  version: '0.0.0-parity',
  allowedProviders: null,
  modelPolicyCapabilities: {},
  localSpeechPack: 'offered',
  usageStats: { meetingsSummarized: 2, conversationMinutes: 50, firstMeetingAt: now - 86400000 },
  timeSaved: { writeupRatio: 0.2, floorMin: 5, capMin: 30 }
}
const perms = { microphone: 'granted', screen: 'granted', accessibility: 'granted' }
window.toto = {
  resize: noop,
  recallList: async () => meetings,
  recallSearch: async () => meetings,
  recallOpen: async () => null,
  recallSetConfidential: async () => ok,
  recallSetCrmPushed: async () => ok,
  recallUpdateRecap: async () => ok,
  debriefSave: async () => ok,
  exportRecapJson: async () => ok,
  mcpPush: async () => ok,
  mcpClickupDiscoverDestination: async () => ({ ok: true, destinations: [] }),
  outlookCreateDraft: async () => ok,
  timeSavedRecord: async () => ok,
  importJobsList: async () => [],
  importAudioPick: async () => ({ files: [] }),
  importAudioDrop: async () => ({ files: [] }),
  importAudioStartBatch: async () => [],
  importJobCancel: async () => ok,
  importJobResume: async () => null,
  importJobRemove: async () => ok,
  onImportAudioProgress: () => noop,
  onImportAssetsProgress: () => noop,
  brainRead: async () => brainData,
  brainStatus: async () => brainStatus,
  brainAttention: async () => ({ items: [] }),
  brainBackfill: async () => ok,
  brainIntelligencePass: async () => ok,
  brainOpenDashboard: async () => ok,
  brainClearJournalCorruption: async () => ok,
  brainCommitmentSettle: async () => ok,
  brainCommitmentReject: async () => ok,
  brainSetDealOutcome: async () => ok,
  brainEntityRename: async () => ok,
  brainEntityUpdateField: async () => ok,
  brainEntityMerge: async () => ({ ok: true, seq: 1 }),
  brainEntityUnmerge: async () => ok,
  getSettings: async () => settings,
  getPermissions: async () => perms,
  requestPermissionsUpfront: async () => perms,
  openPermissionSettings: async () => ok,
  localModelsList: async () => [{ id: 'local-synthetic', downloaded: true, bundled: true }],
  localModelsEnsure: async () => ok,
  asrAssetsStatus: async () => ({ installed: true, ready: true, checking: false }),
  asrAssetsEnsure: async () => ({ installed: true, ready: true, checking: false }),
  licenseActivate: async () => ok,
  relaunch: async () => ok,
  quit: noop,
  onboardingExit: noop
}

function reviewProps() {
  return {
    mode: 'sales',
    recap: { id: 'recap', text: '## Decisions\\nProceed with the launch plan.\\n\\n## Next steps\\nSend the brief and confirm the review owner.', streaming: false, completion: 'complete', error: null, prompt: 'synthetic' },
    recapStatus: 'complete',
    lines: [
      { speaker: 'you', text: 'We will send the launch brief by Friday.', t: 1 },
      { speaker: 'them', text: 'The October plan works for us.', t: 9 }
    ],
    savedPath: meetingFile,
    saveError: null,
    saveAttempts: 1,
    maxSaveAttempts: 3,
    startedAt: now - 32 * 60 * 1000,
    durationMs: 32 * 60 * 1000,
    showTranscript: true,
    meetingMeta: { title: 'Synthetic planning review', date: '2026-10-03T09:00:00Z' },
    confidential: false,
    crmPushedKey: undefined,
    followupDraft: null,
    onOpenFolder: noop,
    onSave: noop,
    onDiscard: noop,
    onDone: noop,
    onResume: noop,
    onGenerateFollowup: noop,
    onRetryRecap: noop,
    onGenerateRecap: noop,
    mcpConnections: [],
    onOpenPastMeeting: noop,
    isPastMeeting: false,
    onRecapSaved: noop,
    onUpdateRecap: async () => ok,
    onDirtyChange: noop,
    recapUnavailable: false,
    finishingTranscript: false
  }
}
function barProps() {
  return {
    value: 'Summarize the renewal risk',
    onChange: noop,
    onSubmit: noop,
    onStop: noop,
    busy: false,
    listening: true,
    onToggleListen: noop,
    paused: false,
    onTogglePause: noop,
    onCapture: noop,
    capturing: false,
    captureAccel: 'Alt+Shift+S',
    onSettings: noop,
    onHistory: noop,
    onMinimize: noop,
    stealth: true,
    onToggleStealth: noop,
    startedAt: now - 47000,
    panelOpen: false,
    onTogglePanel: noop,
    canTogglePanel: true,
    focusSignal: 0,
    mode: 'sales',
    onSetMode: noop,
    onTranscript: noop,
    onNewMeeting: noop,
    canMinimize: true,
    contextLabel: 'Synthetic meeting',
    recognizerStatus: { engine: 'parakeet', model: 'bundled', languageMode: 'auto' }
  }
}
function recordProps() {
  return {
    recordRef: { kind: 'account', id: 'account-example' },
    data: brainData,
    onOpenRecord: noop,
    onOpenMeeting: noop,
    onRefresh: async () => undefined,
    onError: noop,
    onMerged: noop,
    recentMerge: null,
    onUndoMerge: noop,
    onDismissMerge: noop
  }
}
function View({ id }) {
  if (id === 'bar') return <Bar {...barProps()} />
  if (id === 'review') return <Review {...reviewProps()} />
  if (id === 'onboarding-experience') return <OnboardingExperience settings={settings} patch={async (p) => ({ ...settings, ...p })} authReady={true} onDone={noop} onOpenAiSettings={noop} recoverEncryptedProfile={async () => ({ ok: true })} />
  if (id === 'brain-view') return <BrainView onBack={noop} onOpenMeeting={noop} onOpenSettings={noop} onDashboardOpen={noop} />
  if (id === 'recall-view') return <RecallView onOpenFolder={noop} onBack={noop} onConnectCalendar={noop} activeFile={meetingFile} onNewChat={noop} onOpenMeeting={noop} onIntelligence={noop} onOpenSettings={noop} onDashboardOpen={noop} />
  if (id === 'brain-record-page') return <BrainRecordPage {...recordProps()} />
  return <div>Unknown view {id}</div>
}
function App() {
  const params = new URLSearchParams(location.search)
  const view = params.get('view') || 'bar'
  const theme = params.get('theme') || 'dark'
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.dataset.theme = theme
  return (
    <main className={'capture-root ' + theme} data-view={view}>
      <section className="capture-frame">
        <View id={view} />
      </section>
    </main>
  )
}
const style = document.createElement('style')
style.textContent = ${JSON.stringify(`
html, body, #root { min-height: 100%; margin: 0; }
body { font-family: InterVar, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.capture-root { min-height: 100vh; padding: 28px; box-sizing: border-box; }
.capture-root.dark { background: radial-gradient(circle at top left, #30125a, #05010a 54%, #030106); color: white; }
.capture-root.light { background: linear-gradient(135deg, #f7f3ff, #eef4ff 45%, #ffffff); color: #160426; }
.capture-frame { width: min(1180px, calc(100vw - 56px)); min-height: calc(100vh - 56px); display: grid; place-items: center; margin: 0 auto; }
.capture-frame > * { max-width: 100%; }
[data-view="bar"] .capture-frame { min-height: 320px; }
[data-view="onboarding-experience"] .capture-frame { width: min(1280px, calc(100vw - 56px)); min-height: 820px; place-items: stretch; }
[data-view="brain-view"] .capture-frame, [data-view="recall-view"] .capture-frame, [data-view="review"] .capture-frame, [data-view="brain-record-page"] .capture-frame { align-items: start; }
`)};
document.head.append(style)
createRoot(document.getElementById('root')).render(<App />)
`.trimStart()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const harnessDir = writeHarness(args.repo, args.out)
  const server = await createServer({
    root: harnessDir,
    configFile: false,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(args.repo, 'src/renderer/src'),
        '@shared': resolve(args.repo, 'src/shared')
      }
    },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { exclude: ['@huggingface/transformers'] }
  })
  await server.listen()
  const url = server.resolvedUrls?.local?.[0]
  if (!url) throw new Error('Vite did not report a local URL')
  const browser = await chromium.launch({ headless: true })
  const manifest = { ticket: 'M2-0408', label: args.label, repo: relative(process.cwd(), args.repo) || '.', captures: [] }
  try {
    for (const view of args.views) {
      for (const theme of args.themes) {
        const page = await browser.newPage({ viewport: { width: 1280, height: view === 'onboarding-experience' ? 900 : 820 }, deviceScaleFactor: 1 })
        page.on('pageerror', (error) => { throw error })
        await page.goto(`${url}?view=${encodeURIComponent(view)}&theme=${encodeURIComponent(theme)}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(view === 'onboarding-experience' ? 1600 : 900)
        const file = `${args.label}-${view}-${theme}.png`
        const path = resolve(args.out, file)
        await page.screenshot({ path, fullPage: true })
        const title = await page.locator('[data-view]').getAttribute('data-view')
        manifest.captures.push({ view, theme, file, reached: title === view })
        await page.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  writeFileSync(resolve(args.out, `${args.label}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(resolve(args.out, `${args.label}-README.md`), `# M2-0408 ${args.label} renderer parity screenshots\\n\\nCaptured ${manifest.captures.length} synthetic renderer screenshots for Review, OnboardingExperience, BrainView, RecallView, Bar and BrainRecordPage in light and dark variants.\\n\\nOpus review compares these against the paired before/after artifact from the same workflow run.\\n`)
  console.log(`captured ${manifest.captures.length} screenshots in ${args.out}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
