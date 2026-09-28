import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema, type DustAgent, type PublicSettings } from '@shared/ipc'
import { DUST_BASE_AGENT_ID } from '@shared/ipc'
import { AgentPicker, DustSetup } from '../../components/Settings'

function publicSettingsWith(overrides: Partial<PublicSettings> = {}): PublicSettings {
  return PublicSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    hasApiKey: false,
    providerReady: false,
    visionReady: false,
    hasKeys: {},
    hasEncryption: true,
    resolvedMeetingsFolder: '',
    ...overrides
  })
}

const agents: DustAgent[] = [
  {
    sId: DUST_BASE_AGENT_ID,
    name: 'Metis Base',
    description: 'Everyday questions and follow-up drafts',
    modelProviderId: 'anthropic',
    modelId: 'claude-sonnet-4-6'
  },
  {
    sId: 'dust-thinking-agent',
    name: 'Thinking Agent',
    description: 'Hard questions and coding help',
    modelProviderId: 'anthropic',
    modelId: 'claude-sonnet-4-6'
  }
]

describe('AgentPicker', () => {
  it('renders a searchable listbox with descriptions, the default marker, and the selected check', () => {
    const html = renderToStaticMarkup(
      <AgentPicker
        label="Base agent"
        value={DUST_BASE_AGENT_ID}
        agents={agents}
        loading={false}
        err={null}
        onSelect={() => {}}
        placeholder="Base agent id"
        defaultId={DUST_BASE_AGENT_ID}
      />
    )

    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('Metis Base (default)')
    expect(html).toContain('Everyday questions and follow-up drafts')
    expect(html).toContain('Thinking Agent')
  })

  it('keeps a stale saved agent visible instead of collapsing the trigger to blank', () => {
    const html = renderToStaticMarkup(
      <AgentPicker
        label="Base agent"
        value="missing-agent"
        agents={agents}
        loading={false}
        err={null}
        onSelect={() => {}}
        placeholder="Base agent id"
      />
    )

    expect(html).toContain('missing-agent')
    expect(html).toContain('Not in your workspace')
  })

  it('falls back to an editable id field and exposes the load error before agents exist', () => {
    const html = renderToStaticMarkup(
      <AgentPicker
        label="Thinking agent"
        value=""
        agents={null}
        loading={false}
        err="Could not load your agents."
        onSelect={() => {}}
        placeholder="Thinking agent id"
      />
    )

    expect(html).toContain('aria-label="Thinking agent"')
    expect(html).toContain('placeholder="Thinking agent id"')
    expect(html).toContain('Could not load your agents.')
  })
})

describe('DustSetup', () => {
  it('makes automatic Dust setup the primary path and keeps manual API-key setup collapsed', () => {
    const settings = publicSettingsWith({
      provider: 'anthropic',
      providerModels: { ...DEFAULT_SETTINGS.providerModels, dust: DUST_BASE_AGENT_ID }
    })
    const html = renderToStaticMarkup(
      <DustSetup
        settings={settings}
        patch={() => {}}
        saveKey={async () => {}}
        recoverEncryptedProfile={async () => ({ ok: false })}
        clearKey={async () => {}}
        active={false}
      />
    )

    expect(html).toContain('Dust CLI · Your agents')
    expect(html).toContain('Set up Dust automatically')
    expect(html).toContain('Already signed in with the Dust CLI? Import that session')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('I already have an API key')
    expect(html).not.toContain('Dust API key')
  })

  it('shows connected agent selection without calling credentials live proof complete', () => {
    const settings = publicSettingsWith({
      provider: 'dust',
      hasKeys: { dust: true },
      dustWorkspaceId: 'workspace-1',
      providerModels: { ...DEFAULT_SETTINGS.providerModels, dust: DUST_BASE_AGENT_ID },
      providerModelsThinking: { ...DEFAULT_SETTINGS.providerModelsThinking, dust: 'dust-thinking-agent' }
    })
    const html = renderToStaticMarkup(
      <DustSetup
        settings={settings}
        patch={() => {}}
        saveKey={async () => {}}
        recoverEncryptedProfile={async () => ({ ok: false })}
        clearKey={async () => {}}
        active
      />
    )

    expect(html).toContain('Dust CLI · Your agents (active)')
    expect(html).toContain('Reconnect')
    expect(html).toContain('Base agent · answers everyday questions')
    expect(html).toContain('Thinking agent · hard, coding questions · optional')
    expect(html).toContain('Checking Dust connection')
    expect(html).not.toContain('Connected. Workspace')
  })
})
