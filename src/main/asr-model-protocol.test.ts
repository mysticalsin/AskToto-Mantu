import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAsrModelProtocolHandler } from './asr-model-protocol'

describe('real ASR model protocol response boundary', () => {
  let root: string
  let resources: string
  let userModels: string
  const readLocal = vi.fn(async (url: string) => new Response(readFileSync(fileURLToPath(url))))
  const put = (path: string, text = 'synthetic asset'): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const handler = () =>
    createAsrModelProtocolHandler({ resourcesRoot: resources, userModelsRoot: userModels, readLocal })
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'metis-protocol-')))
    resources = join(root, 'resources')
    userModels = join(root, 'profile', 'asr-models')
    mkdirSync(resources, { recursive: true })
    mkdirSync(userModels, { recursive: true })
    readLocal.mockClear()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('serves a bundled model with CORS, MIME and a real byte length', async () => {
    put(join(resources, 'models', 'Xenova', 'whisper-base', 'config.json'), '{"ok":true}')
    const result = await handler()({ url: 'asr-model://models/Xenova/whisper-base/config.json' })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ ok: true })
    expect(result.headers.get('access-control-allow-origin')).toBe('*')
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(result.headers.get('content-length')).toBe('11')
  })

  it('serves the downloaded model from its own root after setup', async () => {
    put(join(userModels, 'Xenova', 'whisper-base', 'config.json'), '{"downloaded":true}')
    const result = await handler()({ url: 'asr-model://models/Xenova/whisper-base/config.json' })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ downloaded: true })
  })

  it('uses only the explicitly selected speech-pack root when the package profile is lean', async () => {
    const pack = join(root, 'speech-packs', 'asr.whisper-base-q8', '2')
    put(join(resources, 'models', 'Xenova', 'whisper-base', 'config.json'), 'bundled fallback must not win')
    put(join(userModels, 'Xenova', 'whisper-base', 'config.json'), 'legacy fallback must not win')
    put(join(pack, 'Xenova', 'whisper-base', 'config.json'), 'selected pack')
    const leanHandler = createAsrModelProtocolHandler({
      resourcesRoot: resources,
      userModelsRoot: userModels,
      speechPackModelsRoot: pack,
      useOnlySpeechPackModels: true,
      readLocal
    })
    const result = await leanHandler({ url: 'asr-model://models/Xenova/whisper-base/config.json' })
    expect(await result.text()).toBe('selected pack')
  })

  it('does not fall back to bundled or user models when lean selected pack is unavailable', async () => {
    put(join(resources, 'models', 'Xenova', 'whisper-base', 'config.json'), 'bundled must not be used')
    put(join(userModels, 'Xenova', 'whisper-base', 'config.json'), 'legacy must not be used')
    const leanHandler = createAsrModelProtocolHandler({
      resourcesRoot: resources,
      userModelsRoot: userModels,
      useOnlySpeechPackModels: true,
      readLocal
    })
    expect((await leanHandler({ url: 'asr-model://models/Xenova/whisper-base/config.json' })).status).toBe(404)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('does not revive a static speech-pack root when the current async resolver denies it', async () => {
    const stalePack = join(root, 'speech-packs', 'asr.whisper-base-q8', '2')
    put(join(stalePack, 'config.json'), 'stale activation')
    const dynamicHandler = createAsrModelProtocolHandler({
      resourcesRoot: resources,
      speechPackModelsRoot: stalePack,
      useOnlySpeechPackModels: true,
      resolveSpeechPackModels: async () => ({ useOnlySpeechPackModels: true }),
      readLocal
    })
    expect((await dynamicHandler({ url: 'asr-model://models/config.json' })).status).toBe(404)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('fails closed for an invalid package profile instead of using full or lean roots', async () => {
    put(join(resources, 'models', 'config.json'), 'bundled must not be used')
    put(join(userModels, 'config.json'), 'user must not be used')
    const invalidHandler = createAsrModelProtocolHandler({
      resourcesRoot: resources,
      userModelsRoot: userModels,
      resolveSpeechPackModels: async () => ({ useOnlySpeechPackModels: true }),
      readLocal
    })
    expect((await invalidHandler({ url: 'asr-model://models/config.json' })).status).toBe(404)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('resolves selected pack availability on each request after activation', async () => {
    const pack = join(root, 'speech-packs', 'asr.whisper-base-q8', '2')
    put(join(resources, 'models', 'config.json'), 'bundled')
    put(join(pack, 'config.json'), 'selected')
    let ready = false
    const dynamicHandler = createAsrModelProtocolHandler({
      resourcesRoot: resources,
      readLocal,
      resolveSpeechPackModels: async () => ({
        useOnlySpeechPackModels: true,
        ...(ready ? { speechPackModelsRoot: pack } : {})
      })
    })
    expect((await dynamicHandler({ url: 'asr-model://models/config.json' })).status).toBe(404)
    ready = true
    expect(await (await dynamicHandler({ url: 'asr-model://models/config.json' })).text()).toBe('selected')
  })

  it('uses a downloaded model even when the bundled models directory never existed', async () => {
    resources = join(root, 'missing-resources')
    put(join(userModels, 'Xenova', 'whisper-base', 'config.json'), 'downloaded')
    expect((await handler()({ url: 'asr-model://models/Xenova/whisper-base/config.json' })).status).toBe(200)
  })

  it('can restrict an installed runtime to bundled resources and ignore a stale userData model', async () => {
    put(join(userModels, 'Xenova', 'whisper-base', 'config.json'), '{"stale":true}')
    const installedHandler = createAsrModelProtocolHandler({
      resourcesRoot: resources,
      userModelsRoot: undefined,
      readLocal
    })

    const result = await installedHandler({ url: 'asr-model://models/Xenova/whisper-base/config.json' })

    expect(result.status).toBe(404)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it.each(['models', 'ort'])('refuses encoded traversal from %s into a sibling app.asar', async (host) => {
    put(join(resources, 'app.asar'), 'synthetic source bytes')
    const result = await handler()({ url: `asr-model://${host}/%2e%2e%2fapp.asar` })
    expect(result.status).toBe(403)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('refuses a model symlink into a sibling resources directory', async () => {
    put(join(resources, 'private', 'secret.json'), 'synthetic secret')
    mkdirSync(join(resources, 'models'), { recursive: true })
    symlinkSync(
      join(resources, 'private'),
      join(resources, 'models', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect((await handler()({ url: 'asr-model://models/escape/secret.json' })).status).toBe(403)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('permits an install root reached through a directory junction', async () => {
    put(join(resources, 'models', 'config.json'), '{}')
    const linked = join(root, 'linked-resources')
    symlinkSync(resources, linked, process.platform === 'win32' ? 'junction' : 'dir')
    resources = linked
    expect((await handler()({ url: 'asr-model://models/config.json' })).status).toBe(200)
  })

  it('serves bundled ORT only, never the user model directory', async () => {
    put(join(resources, 'ort', 'runtime.wasm'))
    put(join(userModels, 'ort', 'user-runtime.js'))
    expect((await handler()({ url: 'asr-model://ort/runtime.wasm' })).status).toBe(200)
    readLocal.mockClear()
    expect((await handler()({ url: 'asr-model://ort/user-runtime.js' })).status).toBe(404)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it.each([
    'asr-model://other/config.json',
    'asr-model://models/%2e%2e%5capp.asar',
    'asr-model://models/C%3a%5csecret.json'
  ])('forbids invalid resource route %s', async (url) => {
    expect((await handler()({ url })).status).toBe(403)
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('returns CORS-enabled404 for a genuinely missing asset', async () => {
    const result = await handler()({ url: 'asr-model://models/missing.json' })
    expect(result.status).toBe(404)
    expect(result.headers.get('access-control-allow-origin')).toBe('*')
    expect(readLocal).not.toHaveBeenCalled()
  })

  it.each(['not a URL', 'asr-model://models/%zz'])('returns CORS-enabled400 for malformed URL %s', async (url) => {
    const result = await handler()({ url })
    expect(result.status).toBe(400)
    expect(result.headers.get('access-control-allow-origin')).toBe('*')
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('rejects downloaded-root symlink escapes too', async () => {
    put(join(root, 'outside', 'secret.json'))
    symlinkSync(join(root, 'outside'), join(userModels, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await handler()({ url: 'asr-model://models/escape/secret.json' })
    expect(result.status).toBe(403)
    expect(result.headers.get('access-control-allow-origin')).toBe('*')
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('keeps failed local reads CORS-enabled without trying a remote resolver', async () => {
    put(join(resources, 'models', 'config.json'))
    readLocal.mockRejectedValueOnce(new Error('synthetic read failure'))
    const result = await handler()({ url: 'asr-model://models/config.json' })
    expect(result.status).toBe(500)
    expect(result.headers.get('access-control-allow-origin')).toBe('*')
    expect(readLocal).toHaveBeenCalledTimes(1)
    expect(readLocal.mock.calls[0][0]).toMatch(/^file:/)
  })
})
