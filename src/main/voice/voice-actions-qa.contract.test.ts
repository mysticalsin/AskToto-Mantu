/**
 * Contracts for the voice-actions installed-app acceptance (V08): the QA hooks are reachable only from the QA
 * identity, they are wired from exactly the places the design names, and a release build keeps voice actions in
 * Preview (off) while a QA build is on by default (owner decision, NEEDS_TONY 2026-10-21 19:30).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_ACTIONS_SETTINGS,
  resolveVoiceActionsEnabled,
  VOICE_ACTIONS_RELEASE_DEFAULT_ON
} from '@shared/voice-actions-settings'
import { contextRecord } from '@shared/context-authority'
import { readModuleSource } from '../../test-helpers/module-source'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', isAccessibilitySupportEnabled: () => false },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import { createVoiceChordWiring } from './chord-wiring'
import { createVoiceRouter } from './voice-router'
import { QA_CHORD_FIFO_COMMAND, QA_CHORD_FIFO_ENV, QA_DESKTOP_SINK_ENV } from '../qa-voice-hooks'

const mainDir = join(__dirname, '..')

function productionSources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...productionSources(path))
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push({ file: path, text: readFileSync(path, 'utf8') })
  }
  return out
}
const rel = (file: string): string =>
  file
    .slice(mainDir.length + 1)
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '')

describe('voice actions default: QA on, release Preview (off)', () => {
  it('a QA identity resolves to on and a release identity resolves to off, with nothing stored', () => {
    for (const stored of [undefined, { enabled: null }] as const) {
      expect(resolveVoiceActionsEnabled(stored, { qaIdentity: true })).toBe(true)
      expect(resolveVoiceActionsEnabled(stored, { qaIdentity: false })).toBe(false)
    }
  })

  it('the shipped default setting follows the build (null), and the single release flag is still off', () => {
    expect(DEFAULT_VOICE_ACTIONS_SETTINGS.enabled).toBeNull()
    // Flips to true only after the owner's physical checklist passes (voice-actions-settings.ts). Until then a
    // release build must not listen for the chord, and this fails loudly if someone flips it by accident.
    expect(VOICE_ACTIONS_RELEASE_DEFAULT_ON).toBe(false)
    expect(resolveVoiceActionsEnabled(undefined, { qaIdentity: false })).toBe(VOICE_ACTIONS_RELEASE_DEFAULT_ON)
  })

  it('an explicit choice wins over the build default in both directions', () => {
    expect(resolveVoiceActionsEnabled({ enabled: true }, { qaIdentity: false })).toBe(true)
    expect(resolveVoiceActionsEnabled({ enabled: false }, { qaIdentity: true })).toBe(false)
  })

  it('the voice runtime resolves the setting with the build identity index.ts passes, and index.ts passes the literal', () => {
    const runtime = readModuleSource(__dirname, './voice-actions-runtime').text
    expect(runtime).toContain('resolveVoiceActionsEnabled(voice(), { qaIdentity: deps.qaIdentity })')
    const index = readModuleSource(__dirname, '../index').text
    expect(index).toMatch(
      /createVoiceActionsRuntime\(\{\r?\n(?:\s+spokenReplies: [\w.]+,\r?\n)?\s+qaIdentity: QA_IDENTITY_BUILD,/
    )
  })
})

describe('the QA voice hooks are reachable only from the QA identity', () => {
  it('only qa-voice-hooks.ts names the two env markers, and index.ts never imports it', () => {
    const owners = productionSources(mainDir)
      .filter(({ text }) => text.includes(QA_CHORD_FIFO_ENV) || text.includes(QA_DESKTOP_SINK_ENV))
      .map(({ file }) => rel(file))
    expect(owners).toEqual(['qa-voice-hooks'])
    expect(readModuleSource(__dirname, '../index').text).not.toContain('qa-voice-hooks')
  })

  it('chord-wiring builds the FIFO source only behind the compile-time QA literal and the voice-hold opt-in', () => {
    const wiring = readModuleSource(__dirname, './chord-wiring').text
    expect(wiring).toMatch(/QA_IDENTITY_BUILD && deps\.qaFifoSource === true/)
    expect(wiring).toContain("import { QA_IDENTITY_BUILD } from '../qa-identity'")
    // The voice hold opts in; the dictation chord must not (two readers would split the FIFO's lines).
    expect(readModuleSource(__dirname, './voice-actions-runtime').text).toMatch(/qaFifoSource: true/)
    expect(readModuleSource(__dirname, '../features/dictation/dictation-runtime').text).not.toContain('qaFifoSource')
  })

  it('the task bridge builds the desktop sink only behind the compile-time QA literal', () => {
    const runtime = readModuleSource(__dirname, '../tasks/desktop-action-task-runtime').text
    expect(runtime).toMatch(/QA_IDENTITY_BUILD &&\r?\n\s+qaDesktopSinkEnabled\(/)
    expect(runtime).toMatch(/qaSink\r?\n\s+\? qaSink\(request, envelope\)\r?\n\s+: executeDesktopAction\(/)
  })

  it('in a non-QA build the FIFO env is ignored: the watcher never gets the FIFO source', () => {
    const before = { fifo: process.env[QA_CHORD_FIFO_ENV], profile: process.env.ASKTOTO_USERDATA }
    process.env[QA_CHORD_FIFO_ENV] = '/synthetic/profile/qa-voice/chord.fifo'
    process.env.ASKTOTO_USERDATA = '/synthetic/profile'
    try {
      const specs: string[] = []
      const wiring = createVoiceChordWiring({
        platform: 'darwin',
        enabled: () => true,
        requireAuth: () => true,
        meetingReserved: () => false,
        onboardingExclusive: () => false,
        qaFifoSource: true,
        isAccessibilitySupportEnabled: () => false,
        power: { on: () => undefined },
        spawnHelper: (spec) => {
          specs.push(spec.command)
          return { kill: () => undefined }
        },
        audit: () => undefined,
        log: () => undefined
      })
      wiring.start()
      expect(specs).not.toContain(QA_CHORD_FIFO_COMMAND)
    } finally {
      if (before.fifo === undefined) delete process.env[QA_CHORD_FIFO_ENV]
      else process.env[QA_CHORD_FIFO_ENV] = before.fifo
      if (before.profile === undefined) delete process.env.ASKTOTO_USERDATA
      else process.env.ASKTOTO_USERDATA = before.profile
    }
  })
})

describe('meeting and other-speaker audio never proposes an action (G36, section 13 phrases)', () => {
  const PHRASES = ['open Notes', 'create a note called groceries', 'what is the capital of France', 'take a photo']
  it.each([
    'other-speaker',
    'screen',
    'document',
    'connector',
    'system'
  ] as const)('a %s record that fits the section 13 table routes to no_authority and never reaches the classifier', async (origin) => {
    const classify = vi.fn(async () => ({ kind: 'action' as const, id: 'desktop.open_notes', args: {} }))
    const router = createVoiceRouter({ providerReady: () => true, classify })
    for (const phrase of PHRASES) {
      expect(await router.route(contextRecord(origin, phrase))).toEqual({ kind: 'no_authority' })
    }
    expect(classify).not.toHaveBeenCalled()
  })
})
