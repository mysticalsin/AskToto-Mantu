import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyOverlaySkillFile,
  clearModeSkillsCacheForTests,
  loadVerifiedSkill,
  setModeSkillsOverlayRoot,
  setModeSkillsRootForTests
} from './mode-skills'
import { applySignedSkillPack, pullOperatorSkillManifest, setOperatorOverlayFetchForTests, stopOperatorOverlayPoll } from './operator-overlay'
import { getOperatorSkillPublicKeyRaw } from './operator-skill-key'
import { verifyOperatorSkillPack } from './operator-skill-verify'
import {
  generateOperatorTestKeypair,
  sha256HexUtf8Body,
  signOperatorSkillPackForTests
} from './operator-test-keypair'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test' }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('./operator-skill-key', () => ({ getOperatorSkillPublicKeyRaw: vi.fn() }))

afterEach(() => {
  stopOperatorOverlayPoll()
  setModeSkillsOverlayRoot(null)
  setModeSkillsRootForTests(null)
  clearModeSkillsCacheForTests()
})

describe('Operator skill manifest download', () => {
  afterEach(() => {
    setOperatorOverlayFetchForTests(null)
  })

  it('does not follow redirects while sending the licence credential', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }))
    setOperatorOverlayFetchForTests(fetcher as typeof fetch)
    expect(await pullOperatorSkillManifest({ operatorUrl: 'https://operator.test', operatorLicenseToken: 'METIS-OP-1.fixture' })).toBe(0)
    expect(fetcher).toHaveBeenCalledWith('https://operator.test/v1/skills/manifest', expect.objectContaining({
      redirect: 'manual', headers: expect.objectContaining({ 'x-metis-license': 'METIS-OP-1.fixture' })
    }))
  })

  it.each(['clear', 'replace'])('cannot apply an old signed manifest after licence %s', async (change) => {
    const keys = generateOperatorTestKeypair()
    vi.mocked(getOperatorSkillPublicKeyRaw).mockReturnValue(keys.publicKeyRaw)
    const body = '---\nid: interview\nversion: 9.9.9\nlocked: true\n---\n\nObsolete account instructions.\n'
    const signed = signOperatorSkillPackForTests(
      { skillId: 'interview', version: '9.9.9', sha256: sha256HexUtf8Body(body), body }, keys.privateKeyPem
    )
    expect(verifyOperatorSkillPack(signed)?.version).toBe('9.9.9')
    setModeSkillsOverlayRoot(mkdtempSync(join(tmpdir(), 'metis-overlay-stale-')))
    let complete!: (response: Response) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, skills: [] }), { headers: { 'content-type': 'application/json' } }))
    setOperatorOverlayFetchForTests(fetcher as typeof fetch)
    const pending = pullOperatorSkillManifest({ operatorUrl: 'https://operator.test', operatorLicenseToken: 'METIS-OP-1.old' })
    if (change === 'clear') stopOperatorOverlayPoll()
    else await pullOperatorSkillManifest({ operatorUrl: 'https://operator.test', operatorLicenseToken: 'METIS-OP-1.new' })
    complete(new Response(JSON.stringify({ ok: true, skills: [{ signed }] }), { headers: { 'content-type': 'application/json' } }))
    expect(await pending).toBe(0)
    expect(loadVerifiedSkill('interview').version).not.toBe('9.9.9')
  })

  it('does not treat Access login HTML as a skill pack', async () => {
    setOperatorOverlayFetchForTests(
      async () =>
        new Response(
          '<!DOCTYPE html><html><body>Sign in · Cloudflare Access https://team.cloudflareaccess.com</body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        )
    )
    const applied = await pullOperatorSkillManifest({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(applied).toBe(0)
  })
})

describe('Approve without Push vs signed overlay', () => {
  it('leaves the shipped skill in place until a verified pack is applied', () => {
    const keys = generateOperatorTestKeypair()
    const shipped = loadVerifiedSkill('interview')
    expect(shipped.version).toMatch(/^\d+\.\d+\.\d+$/)

    const overlay = mkdtempSync(join(tmpdir(), 'metis-overlay-'))
    setModeSkillsOverlayRoot(overlay)
    expect(loadVerifiedSkill('interview').sha256).toBe(shipped.sha256)

    expect(applySignedSkillPack('not-a-token', keys.publicKeyRaw)).toBe(false)
    expect(loadVerifiedSkill('interview').sha256).toBe(shipped.sha256)

    const body = `---\nid: interview\nversion: 9.9.9\nlocked: true\n---\n\nStay the candidate. Humanizer stays.\n`
    const signed = signOperatorSkillPackForTests(
      { skillId: 'interview', version: '9.9.9', sha256: sha256HexUtf8Body(body), body },
      keys.privateKeyPem
    )
    expect(verifyOperatorSkillPack(signed, keys.publicKeyRaw)?.version).toBe('9.9.9')
    expect(applySignedSkillPack(signed, keys.publicKeyRaw)).toBe(true)
    const overlaid = loadVerifiedSkill('interview')
    expect(overlaid.version).toBe('9.9.9')
    expect(overlaid.body).toContain('Stay the candidate')
    expect(readFileSync(join(overlay, 'interview', 'SKILL.md'), 'utf8')).toBe(body)
  })

  it('refuses a pack whose hash does not match the body', () => {
    const keys = generateOperatorTestKeypair()
    const overlay = mkdtempSync(join(tmpdir(), 'metis-overlay-bad-'))
    setModeSkillsOverlayRoot(overlay)
    const body = `---\nid: interview\nversion: 9.9.8\nlocked: true\n---\n\nbody\n`
    const signed = signOperatorSkillPackForTests(
      { skillId: 'interview', version: '9.9.8', sha256: '0'.repeat(64), body },
      keys.privateKeyPem
    )
    expect(applySignedSkillPack(signed, keys.publicKeyRaw)).toBe(false)
    expect(loadVerifiedSkill('interview').version).not.toBe('9.9.8')
    const good = `---\nid: interview\nversion: 9.9.7\nlocked: true\n---\n\nStay the candidate.\n`
    applyOverlaySkillFile('interview', good)
    writeFileSync(join(overlay, 'interview', 'SKILL.md'), good.replace('candidate', 'tampered'), 'utf8')
    expect(() => {
      clearModeSkillsCacheForTests()
      loadVerifiedSkill('interview')
    }).toThrow(/hash mismatch/)
  })

  it('refuses a caveman pack — Ask embeds the shipped skill, Operator does not overlay it', () => {
    const keys = generateOperatorTestKeypair()
    const overlay = mkdtempSync(join(tmpdir(), 'metis-overlay-caveman-'))
    setModeSkillsOverlayRoot(overlay)
    const body = `---\nid: caveman\nversion: 9.9.1\nlocked: true\n---\n\nFake overlay caveman.\n`
    const signed = signOperatorSkillPackForTests(
      { skillId: 'caveman', version: '9.9.1', sha256: sha256HexUtf8Body(body), body },
      keys.privateKeyPem
    )
    expect(applySignedSkillPack(signed, keys.publicKeyRaw)).toBe(false)
    expect(loadVerifiedSkill('caveman').body).not.toContain('Fake overlay caveman')
  })
})
