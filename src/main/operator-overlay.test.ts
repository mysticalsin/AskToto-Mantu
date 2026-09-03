import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySignedSkillPack, pullOperatorSkillManifest, setOperatorOverlayFetchForTests } from './operator-overlay'
import { verifyOperatorSkillPack } from './operator-skill-verify'
import {
  generateOperatorTestKeypair,
  sha256HexUtf8Body,
  signOperatorSkillPackForTests
} from './operator-test-keypair'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test' }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

describe('Operator skill manifest download', () => {
  afterEach(() => {
    setOperatorOverlayFetchForTests(null)
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

describe('signed overlay verify (apply skipped without mode-skills)', () => {
  it('accepts a verified pack and refuses a bad token or hash', () => {
    const keys = generateOperatorTestKeypair()
    expect(applySignedSkillPack('not-a-token', keys.publicKeyRaw)).toBe(false)

    const body = `---\nid: interview\nversion: 9.9.9\nlocked: true\n---\n\nStay the candidate.\n`
    const signed = signOperatorSkillPackForTests(
      { skillId: 'interview', version: '9.9.9', sha256: sha256HexUtf8Body(body), body },
      keys.privateKeyPem
    )
    expect(verifyOperatorSkillPack(signed, keys.publicKeyRaw)?.version).toBe('9.9.9')
    expect(applySignedSkillPack(signed, keys.publicKeyRaw)).toBe(true)

    const badHash = signOperatorSkillPackForTests(
      { skillId: 'interview', version: '9.9.8', sha256: '0'.repeat(64), body },
      keys.privateKeyPem
    )
    expect(applySignedSkillPack(badHash, keys.publicKeyRaw)).toBe(false)
  })
})
