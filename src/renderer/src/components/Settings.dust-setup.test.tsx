/**
 * Behaviour tests for the Dust setup card and its agent picker (M2-0071 slice 1, written before either moves
 * out of Settings.tsx). The suite runs in a node environment with no DOM, so components are driven through a
 * tiny hook harness: useState/useRef/useId keep their slots between renders, effects never run (mount-time
 * probes are not under test), and the returned element tree is searched for the handlers a user would hit.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, DUST_BASE_AGENT_ID, PublicSettingsSchema, type DustAgent, type PublicSettings } from '@shared/ipc'
import { DUST_WORKSPACE_MISSING_SETUP_ERROR } from '@shared/dust-validate'
import { AgentPicker, DustSetup } from './Settings'

const hooks = vi.hoisted(() => ({ slots: new Map<number, { current: unknown }>(), next: 0 }))

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  const slot = <T,>(init: () => T): { current: T } => {
    const key = hooks.next++
    if (!hooks.slots.has(key)) hooks.slots.set(key, { current: init() })
    return hooks.slots.get(key) as { current: T }
  }
  return {
    ...react,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useId: () => `id${hooks.next++}`,
    useRef: (init: unknown) => slot(() => init),
    useState: (init: unknown) => {
      const s = slot(() => (typeof init === 'function' ? (init as () => unknown)() : init))
      return [
        s.current,
        (next: unknown) => {
          s.current = typeof next === 'function' ? (next as (prev: unknown) => unknown)(s.current) : next
        }
      ]
    }
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Props = Record<string, any>
type El = ReactElement<Props>

function elements(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out))
  else if (isValidElement(node)) {
    out.push(node as El)
    elements((node as El).props.children, out)
  }
  return out
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as El).props.children)
  return ''
}

/** A mounted component: `view()` re-renders against the same hook slots, like React after a state change. */
function mount(component: (props: never) => JSX.Element, props: Props) {
  hooks.slots.clear()
  const view = (): { all: El[]; text: string } => {
    hooks.next = 0
    const tree = (component as (p: Props) => JSX.Element)(props)
    return { all: elements(tree), text: textOf(tree) }
  }
  return {
    view,
    button: (label: RegExp): El => {
      const found = view().all.find((e) => e.type === 'button' && label.test(textOf(e.props.children)))
      if (!found) throw new Error(`no button matching ${label}`)
      return found
    },
    input: (match: (p: Props) => boolean): El => {
      const found = view().all.find((e) => e.type === 'input' && match(e.props))
      if (!found) throw new Error('no matching input')
      return found
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const typeInto = (input: El, value: string): void => input.props.onChange({ target: { value } })

function makeSettings(overrides: Partial<PublicSettings> = {}): PublicSettings {
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

const AGENTS: DustAgent[] = [
  { sId: 'agentA', name: 'Alpha', description: 'Answers sales questions' },
  { sId: DUST_BASE_AGENT_ID, name: 'Métis', description: 'The default agent' }
]

type Toto = Record<string, ReturnType<typeof vi.fn>>
let toto: Toto

beforeEach(() => {
  toto = {
    testApiKey: vi.fn(async () => ({ ok: true })),
    dustListAgents: vi.fn(async () => ({ ok: true, agents: AGENTS })),
    dustInstallCli: vi.fn(async () => ({ ok: true })),
    dustLoginBegin: vi.fn(async () => ({
      ok: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://example.invalid/verify',
      intervalSec: 5,
      expiresInSec: 300
    }))
  }
  vi.stubGlobal('window', { toto, navigator: { platform: 'MacIntel' } })
})
afterEach(() => vi.unstubAllGlobals())

describe('AgentPicker', () => {
  const base = {
    label: 'Base agent',
    value: '',
    agents: AGENTS,
    loading: false,
    err: null,
    placeholder: 'Pick an agent'
  }

  it('shows only a status (no input, no popup) while the first agent list is loading', () => {
    const picker = mount(AgentPicker, { ...base, agents: null, loading: true, onSelect: vi.fn() })
    const { all } = picker.view()
    expect(all.some((e) => e.type === 'input' || e.type === 'button')).toBe(false)
  })

  it('falls back to a bare sId input with the error when no agents loaded', () => {
    const onSelect = vi.fn()
    const onEmptyBlur = vi.fn()
    const picker = mount(AgentPicker, { ...base, agents: null, err: 'Could not load', onSelect, onEmptyBlur })
    expect(picker.view().text).toContain('Could not load')
    const input = picker.input((p) => p['aria-label'] === 'Base agent')
    typeInto(input, 'pasted-id')
    expect(onSelect).toHaveBeenCalledWith('pasted-id')
    input.props.onBlur({ target: { value: '   ' } })
    expect(onEmptyBlur).toHaveBeenCalledTimes(1)
    input.props.onBlur({ target: { value: 'pasted-id' } })
    expect(onEmptyBlur).toHaveBeenCalledTimes(1)
  })

  it('opens a searchable list, tags the default agent and selects a row', () => {
    const onSelect = vi.fn()
    const picker = mount(AgentPicker, { ...base, defaultId: DUST_BASE_AGENT_ID, onSelect })
    expect(picker.view().text).toBe('Pick an agent')
    picker.button(/Pick an agent/).props.onClick()
    const opened = picker.view()
    expect(opened.text).toContain('Alpha')
    expect(opened.text).toContain('Answers sales questions')
    expect(opened.text).toContain('Métis (default)')
    picker.button(/Alpha/).props.onClick()
    expect(onSelect).toHaveBeenCalledWith('agentA')
    expect(picker.view().text).not.toContain('Answers sales questions')
  })

  it('filters by name or description, and Enter picks the first match', () => {
    const onSelect = vi.fn()
    const picker = mount(AgentPicker, { ...base, onSelect })
    picker.button(/Pick an agent/).props.onClick()
    const filter = picker.input((p) => p.placeholder === 'Filter agents…')
    typeInto(filter, 'nothing-like-this')
    expect(picker.view().text).toContain('No matching agents.')
    typeInto(picker.input((p) => p.placeholder === 'Filter agents…'), 'default agent')
    picker.input((p) => p.placeholder === 'Filter agents…').props.onKeyDown({ key: 'Enter', stopPropagation: vi.fn() })
    expect(onSelect).toHaveBeenCalledWith(DUST_BASE_AGENT_ID)
  })

  it('keeps a saved sId that left the workspace visible and selectable', () => {
    const picker = mount(AgentPicker, { ...base, value: 'gone123', onSelect: vi.fn() })
    expect(picker.view().text).toBe('gone123')
    picker.button(/gone123/).props.onClick()
    expect(picker.view().text).toContain('Not in your workspace')
  })

  it('offers an empty row on top only when emptyOption is set', () => {
    const onSelect = vi.fn()
    const picker = mount(AgentPicker, { ...base, emptyOption: 'Same as base agent', onSelect })
    // The empty row is the current selection, so the trigger already reads as the empty option.
    picker.button(/Same as base agent/).props.onClick()
    const rows = picker.view().all.filter((e) => e.type === 'button' && /Same as base agent/.test(textOf(e.props.children)))
    expect(rows).toHaveLength(2)
    rows[1].props.onClick()
    expect(onSelect).toHaveBeenCalledWith('')

    const without = mount(AgentPicker, { ...base, onSelect })
    without.button(/Pick an agent/).props.onClick()
    expect(without.view().text).not.toContain('Same as base agent')
  })

  it('disables the trigger when the picker is locked', () => {
    const picker = mount(AgentPicker, { ...base, disabled: true, onSelect: vi.fn() })
    expect(picker.button(/Pick an agent/).props.disabled).toBe(true)
  })
})

describe('DustSetup', () => {
  function setup(overrides: Partial<PublicSettings> = {}) {
    const settings = makeSettings(overrides)
    const patch = vi.fn(async () => {})
    const saveKey = vi.fn(async () => {})
    const clearKey = vi.fn(async () => {})
    const recoverEncryptedProfile = vi.fn(async () => ({ ok: true }))
    const card = mount(DustSetup, { settings, patch, saveKey, clearKey, recoverEncryptedProfile, active: false })
    return { settings, patch, saveKey, clearKey, card }
  }
  const connected = { dustWorkspaceId: 'ws123', hasKeys: { dust: true } } as Partial<PublicSettings>

  it('starts on the one-click setup with the manual key path collapsed', () => {
    const { card } = setup()
    const { text } = card.view()
    expect(text).toContain('Set up Dust automatically')
    expect(card.view().all.some((e) => e.type === 'input')).toBe(false)
    card.button(/I already have an API key/).props.onClick()
    expect(card.view().all.some((e) => e.type === 'input' && e.props.placeholder?.startsWith('Paste your Dust API key'))).toBe(true)
  })

  it('a pasted assistant link fills workspace, region and base agent', () => {
    const { card, patch, settings } = setup()
    card.button(/I already have an API key/).props.onClick()
    typeInto(
      card.input((p) => p.placeholder?.startsWith('Paste your Dust workspace or agent URL')),
      'https://eu.dust.tt/w/abc123/builder/agents/myAgent'
    )
    expect(patch).toHaveBeenCalledWith({
      dustWorkspaceId: 'abc123',
      dustBaseUrl: 'https://eu.dust.tt',
      providerModels: { ...settings.providerModels, dust: 'myAgent' }
    })
  })

  it('the region buttons patch the Dust base URL', () => {
    const { card, patch } = setup()
    card.button(/I already have an API key/).props.onClick()
    card.button(/EU · eu\.dust\.tt/).props.onClick()
    expect(patch).toHaveBeenCalledWith({ dustBaseUrl: 'https://eu.dust.tt' })
    card.button(/US · dust\.tt/).props.onClick()
    expect(patch).toHaveBeenCalledWith({ dustBaseUrl: 'https://dust.tt' })
  })

  it('proves a pasted key before saving it, then activates Dust and loads agents', async () => {
    const { card, patch, saveKey } = setup({ dustWorkspaceId: 'ws123' })
    card.button(/I already have an API key/).props.onClick()
    typeInto(card.input((p) => p.placeholder?.startsWith('Paste your Dust API key')), 'sk-test')
    card.button(/^\s*Save\s*$/).props.onClick()
    await flush()
    expect(toto.testApiKey).toHaveBeenCalledWith('dust', 'sk-test')
    expect(saveKey).toHaveBeenCalledWith('dust', 'sk-test')
    expect(toto.testApiKey.mock.invocationCallOrder[0]).toBeLessThan(saveKey.mock.invocationCallOrder[0])
    expect(patch).toHaveBeenCalledWith({ provider: 'dust' })
    expect(toto.dustListAgents).toHaveBeenCalledTimes(1)
    expect(card.view().text).toContain('Connected.')
  })

  it('a rejected key is never saved and the reason is shown', async () => {
    toto.testApiKey.mockResolvedValue({ ok: false, error: 'Dust rejected the key (401)' })
    const { card, patch, saveKey } = setup({ dustWorkspaceId: 'ws123' })
    card.button(/I already have an API key/).props.onClick()
    typeInto(card.input((p) => p.placeholder?.startsWith('Paste your Dust API key')), 'sk-bad')
    card.button(/^\s*Save\s*$/).props.onClick()
    await flush()
    expect(saveKey).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
    expect(toto.dustListAgents).not.toHaveBeenCalled()
    expect(card.view().text).toContain('Dust rejected the key (401)')
  })

  it('refuses to test a key without a workspace id', async () => {
    const { card, saveKey } = setup({ dustWorkspaceId: '' })
    card.button(/I already have an API key/).props.onClick()
    typeInto(card.input((p) => p.placeholder?.startsWith('Paste your Dust API key')), 'sk-test')
    card.button(/^\s*Save\s*$/).props.onClick()
    await flush()
    expect(toto.testApiKey).not.toHaveBeenCalled()
    expect(saveKey).not.toHaveBeenCalled()
    expect(card.view().text).toContain(DUST_WORKSPACE_MISSING_SETUP_ERROR)
  })

  it('Disconnect clears the key and resets workspace, region and base agent', async () => {
    const { card, patch, clearKey, settings } = setup({
      ...connected,
      provider: 'dust',
      dustBaseUrl: 'https://eu.dust.tt',
      providerModels: { dust: 'customAgent' }
    })
    card.button(/Disconnect/).props.onClick()
    await flush()
    expect(clearKey).toHaveBeenCalledWith('dust')
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        dustWorkspaceId: '',
        dustBaseUrl: 'https://dust.tt',
        dustTokenMintedAt: 0,
        providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID }
      })
    )
  })

  it('reports a failed CLI install without starting the sign-in', async () => {
    toto.dustInstallCli.mockResolvedValue({ ok: false, error: 'Install blocked by policy' })
    const { card } = setup()
    card.button(/Set up Dust automatically/).props.onClick()
    await flush()
    expect(toto.dustLoginBegin).not.toHaveBeenCalled()
    expect(card.view().text).toContain('Install blocked by policy')
  })

  it('shows the device code while waiting and Cancel returns to the start', async () => {
    const { card } = setup()
    card.button(/Set up Dust automatically/).props.onClick()
    await flush()
    const waiting = card.view().text
    expect(waiting).toContain('Waiting for you to finish in your browser…')
    expect(waiting).toContain('ABCD-1234')
    card.button(/Cancel/).props.onClick()
    expect(card.view().text).toContain('Set up Dust automatically')
  })

  it('loaded agents feed both pickers, and picking patches the trimmed agent ids', async () => {
    const { card, patch, settings } = setup({ ...connected, providerModels: { dust: 'agentA' } })
    card.button(/Load my agents/).props.onClick()
    await flush()
    const pickers = card.view().all.filter((e) => e.type === AgentPicker)
    expect(pickers.map((p) => p.props.label)).toEqual(['Base agent', 'Thinking agent'])
    expect(pickers[0].props.agents).toEqual(AGENTS)
    pickers[0].props.onSelect(` ${DUST_BASE_AGENT_ID} `)
    expect(patch).toHaveBeenCalledWith({ providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID } })
    pickers[1].props.onSelect(' agentA ')
    expect(patch).toHaveBeenCalledWith({
      providerModelsThinking: { ...settings.providerModelsThinking, dust: 'agentA' }
    })
    expect(pickers[1].props.emptyOption).toBe('Same as base agent')
  })

  it('offers a reset to the Métis default only once the base agent was changed', () => {
    const { card, patch, settings } = setup({ ...connected, providerModels: { dust: 'agentA' } })
    card.button(/Reset to Métis default/).props.onClick()
    expect(patch).toHaveBeenCalledWith({ providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID } })

    const fresh = setup({ ...connected, providerModels: { dust: DUST_BASE_AGENT_ID } })
    expect(fresh.card.view().text).not.toContain('Reset to Métis default')
  })
})
