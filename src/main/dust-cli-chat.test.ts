import { describe, expect, it, vi } from 'vitest'

vi.mock('electron')

import { DUST_SPOTLIGHT_REF_AGENT_ID } from '@shared/ipc'
import {
  buildDustSpotlightChatArgv,
  classifyDustCliChatFailure,
  dustChatArgvHasWithTools,
  dustChatEnv,
  messageForDustCliKind,
  parseDustChatStdout,
  projectNameForDataAndAiAsk,
  spotlightRefMissingAgentMessage,
  spotlightRefMissingCliMessage
} from './dust-cli-chat'
import { MANAGED_CLIS } from './cli-installer'

describe('managed Dust CLI install id', () => {
  it('exists on MANAGED_CLIS with the published package and entry', () => {
    expect(MANAGED_CLIS.dust.id).toBe('dust')
    expect(MANAGED_CLIS.dust.npmPackage).toBe('@dust-tt/dust-cli')
    expect(MANAGED_CLIS.dust.binRelPath).toBe('dist/index.js')
  })
})

describe('Spotlight Ref dust chat argv', () => {
  it('contains --sId GOr913Zr5V and -m and never --with-tools', () => {
    const args = buildDustSpotlightChatArgv({ message: 'Data and AI projects' })
    expect(args).toContain('chat')
    expect(args).toContain('--sId')
    expect(args[args.indexOf('--sId') + 1]).toBe(DUST_SPOTLIGHT_REF_AGENT_ID)
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('Data and AI projects')
    expect(dustChatArgvHasWithTools(args)).toBe(false)
    expect(args).not.toContain('--with-tools')
    expect(args).not.toContain('-t')
  })

  it('adds --projectName only when a real name is supplied — does not invent one', () => {
    const without = buildDustSpotlightChatArgv({ message: 'hello' })
    expect(without).not.toContain('--projectName')
    const withName = buildDustSpotlightChatArgv({ message: 'hello', projectName: 'Data and AI' })
    expect(withName).toContain('--projectName')
    expect(withName[withName.indexOf('--projectName') + 1]).toBe('Data and AI')
  })

  it('headless env uses DUST_API_KEY + DUST_WORKSPACE_ID', () => {
    expect(dustChatEnv({ apiKey: 'sk-test', workspaceId: 'ws_1' })).toEqual({
      CI: '1',
      DUST_API_KEY: 'sk-test',
      DUST_WORKSPACE_ID: 'ws_1'
    })
  })
})

describe('missing CLI is install, not reconnect', () => {
  it('classifies a missing binary as missing-cli and names Set up Dust / install', () => {
    expect(classifyDustCliChatFailure('spawn dust ENOENT', { cliInstalled: false })).toBe('missing-cli')
    const msg = messageForDustCliKind('missing-cli', 'nope')
    expect(msg).toBe(spotlightRefMissingCliMessage())
    expect(msg.toLowerCase()).toMatch(/install|set up dust/)
    expect(msg.toLowerCase()).not.toContain('reconnect')
  })

  it('classifies an agent miss as not-in-this-workspace, not reconnect', () => {
    expect(classifyDustCliChatFailure('Error: Agent not found: No agent found matching "Spotlight Ref"')).toBe(
      'missing-agent'
    )
    const msg = spotlightRefMissingAgentMessage()
    expect(msg.toLowerCase()).toContain('not in this workspace')
    expect(msg.toLowerCase()).not.toContain('reconnect')
  })
})

describe('parseDustChatStdout', () => {
  it('reads agentAnswer from the CLI JSON', () => {
    const r = parseDustChatStdout(
      JSON.stringify({ agentId: 'GOr913Zr5V', agentAnswer: 'Data and AI, AI wiki', conversationId: 'c1' })
    )
    expect(r.agentAnswer).toBe('Data and AI, AI wiki')
  })
})

describe('projectNameForDataAndAiAsk', () => {
  it('passes --projectName only for a real "Data and AI" name Dust returned', () => {
    expect(projectNameForDataAndAiAsk('Data and AI projects', ['Sales', 'Data and AI'])).toBe('Data and AI')
    expect(projectNameForDataAndAiAsk('Data and AI projects', ['Sales wiki'])).toBeUndefined()
    expect(projectNameForDataAndAiAsk('hello', ['Data and AI'])).toBeUndefined()
  })
})
