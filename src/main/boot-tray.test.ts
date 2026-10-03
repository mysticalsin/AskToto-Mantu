import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  buildTrayInStages,
  createSingleFlight,
  formatTrayAccelerator,
  hiDpiSiblingPath,
  loadPresizedTrayIcon,
  loadTrayIcon,
  scheduleTrayAfterFirstPaint,
  TRAY_ICON_SIZE,
  trayIconPaths,
  TRAY_THUMBNAIL_TIMEOUT_MS,
  yieldToEventLoop,
  type TrayGateWindow,
  type TraySize
} from './boot-tray'

function fakeWindow(opts: { loading?: boolean; url?: string; destroyed?: boolean } = {}) {
  type Gate = Omit<TrayGateWindow, 'webContents'> & { webContents: EventEmitter & TrayGateWindow['webContents'] }
  const win = new EventEmitter() as EventEmitter & Gate
  const contents = new EventEmitter()
  win.isDestroyed = () => opts.destroyed ?? false
  win.webContents = Object.assign(contents, {
    isLoading: () => opts.loading ?? true,
    getURL: () => opts.url ?? ''
  })
  return win
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('scheduleTrayAfterFirstPaint (M2-0422)', () => {
  afterEach(() => vi.useRealTimers())

  it('does not build the tray until the window has painted, then builds it in a later task', async () => {
    const win = fakeWindow()
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(win, build)
    await flush()
    expect(build).not.toHaveBeenCalled()

    win.emit('ready-to-show')
    expect(build).not.toHaveBeenCalled()
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('builds the tray once when both ready-to-show and did-finish-load fire', async () => {
    const win = fakeWindow()
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(win, build)
    win.emit('ready-to-show')
    win.webContents.emit('did-finish-load')
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('builds the tray at once when there is no usable window', () => {
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(null, build)
    scheduleTrayAfterFirstPaint(fakeWindow({ destroyed: true }), build)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('builds the tray after the current task when the window has already loaded', async () => {
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(fakeWindow({ loading: false, url: 'app://index' }), build)
    expect(build).not.toHaveBeenCalled()
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('falls back to a bounded timer when the paint never reports', async () => {
    vi.useFakeTimers()
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(fakeWindow(), build)
    await vi.advanceTimersByTimeAsync(5000)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('buildTrayInStages loads, creates, decorates, builds and attaches the menu in five separate tasks, in order', async () => {
    const order: string[] = []
    const labels: string[] = []
    const fail = vi.fn()
    const done = buildTrayInStages<string, string>({
      loadIcon: async () => {
        order.push('load')
        return 'icon'
      },
      create: (icon) => order.push(`create:${icon}`),
      decorate: (icon) => order.push(`decorate:${icon}`),
      buildMenu: () => {
        order.push('build-menu')
        return 'the-menu'
      },
      attachMenu: (menu) => order.push(`menu:${menu}`),
      time: (label, fn) => {
        labels.push(label)
        return fn()
      },
      fail
    })
    // Every stage boundary is a task boundary: each immediate, queued by the one before it, runs before the next
    // stage, so no two stages share a main-thread task.
    const between = ['between-load-and-create', 'between-create-and-decorate', 'between-decorate-and-build', 'between-build-and-menu']
    const queue = (i: number): void => {
      if (i < between.length) setImmediate(() => {
        order.push(between[i])
        queue(i + 1)
      })
    }
    queue(0)
    await done
    expect(order).toEqual([
      'load',
      'between-load-and-create',
      'create:icon',
      'between-create-and-decorate',
      'decorate:icon',
      'between-decorate-and-build',
      'build-menu',
      'between-build-and-menu',
      'menu:the-menu'
    ])
    expect(labels).toEqual(['createTray.newTray', 'createTray.decorate', 'createTray.buildMenu', 'createTray.attachMenu'])
    expect(fail).not.toHaveBeenCalled()
  })

  it('buildTrayInStages reports a failing stage once and runs no later stage', async () => {
    const decorate = vi.fn()
    const buildMenu = vi.fn()
    const attachMenu = vi.fn()
    const fail = vi.fn()
    await buildTrayInStages<string>({
      loadIcon: async () => 'icon',
      create: () => {
        throw new Error('status item refused')
      },
      decorate,
      buildMenu,
      attachMenu,
      time: (_label, fn) => fn(),
      fail
    })
    expect(decorate).not.toHaveBeenCalled()
    expect(buildMenu).not.toHaveBeenCalled()
    expect(attachMenu).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledExactlyOnceWith(new Error('status item refused'))
  })

  it.each(['decorate', 'buildMenu', 'attachMenu'] as const)(
    'buildTrayInStages reports a failing %s once, runs no later stage and times no stage after it',
    async (failing) => {
      const stages = ['create', 'decorate', 'buildMenu', 'attachMenu'] as const
      const ran: string[] = []
      const labels: string[] = []
      const stage = (name: (typeof stages)[number]) => (): void => {
        if (name === failing) throw new Error(`${name} failed`)
        ran.push(name)
      }
      const fail = vi.fn()
      await buildTrayInStages<string, void>({
        loadIcon: async () => 'icon',
        create: stage('create'),
        decorate: stage('decorate'),
        buildMenu: stage('buildMenu'),
        attachMenu: stage('attachMenu'),
        time: (label, fn) => {
          labels.push(label)
          return fn()
        },
        fail
      })
      const at = stages.indexOf(failing)
      expect(ran).toEqual(stages.slice(0, at))
      expect(labels).toEqual(
        ['createTray.newTray', 'createTray.decorate', 'createTray.buildMenu', 'createTray.attachMenu'].slice(0, at + 1)
      )
      expect(fail).toHaveBeenCalledExactlyOnceWith(new Error(`${failing} failed`))
    }
  )

  it('buildTrayInStages reports an icon load rejection without creating a tray', async () => {
    const create = vi.fn()
    const fail = vi.fn()
    await buildTrayInStages<string>({
      loadIcon: () => Promise.reject(new Error('decode failed')),
      create,
      decorate: vi.fn(),
      buildMenu: vi.fn(),
      attachMenu: vi.fn(),
      time: (_label, fn) => fn(),
      fail
    })
    expect(create).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledExactlyOnceWith(new Error('decode failed'))
  })

  it('yieldToEventLoop resolves in a later task', async () => {
    const order: string[] = []
    setImmediate(() => order.push('immediate'))
    await yieldToEventLoop()
    order.push('after-yield')
    expect(order).toEqual(['immediate', 'after-yield'])
  })
})

describe('createSingleFlight (M2-0031)', () => {
  it('ignores starts while a run is in flight and accepts one after it settles, rejected or not', async () => {
    const start = createSingleFlight()
    let finish: (() => void) | undefined
    const first = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const second = vi.fn(async () => undefined)
    start(first)
    start(second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    finish?.()
    await yieldToEventLoop()
    const failing = vi.fn(() => Promise.reject(new Error('stage failed')))
    start(failing)
    expect(failing).toHaveBeenCalledTimes(1)
    await yieldToEventLoop()
    start(second)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('loadTrayIcon (M2-0031)', () => {
  type FakeImage = { name: string; isEmpty(): boolean; resize: Mock<(size: TraySize) => FakeImage> }
  const image = (name: string, empty = false): FakeImage => ({
    name,
    isEmpty: () => empty,
    resize: vi.fn((_size: TraySize): FakeImage => image(`${name}@resized`))
  })
  const loader = (thumbnail: () => Promise<FakeImage>, full = image('full')) => ({
    createThumbnailFromPath: vi.fn((_path: string, _size: TraySize) => thumbnail()),
    createFromPath: vi.fn((_path: string) => full)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('on macOS uses the off-thread thumbnail at the tray size and never decodes in-process', async () => {
    const images = loader(async () => image('thumb'))
    const icon = await loadTrayIcon(images, '/icon.png', 'darwin')
    expect(icon.name).toBe('thumb')
    expect(images.createThumbnailFromPath).toHaveBeenCalledExactlyOnceWith('/icon.png', TRAY_ICON_SIZE)
    expect(images.createFromPath).not.toHaveBeenCalled()
  })

  it('off macOS decodes in-process and resizes, without the thumbnailer', async () => {
    const images = loader(async () => image('thumb'))
    const icon = await loadTrayIcon(images, '/icon.png', 'win32')
    expect(icon.name).toBe('full@resized')
    expect(images.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('falls back to the in-process decode when the thumbnail is empty or rejects', async () => {
    expect((await loadTrayIcon(loader(async () => image('thumb', true)), '/icon.png', 'darwin')).name).toBe('full@resized')
    const rejecting = loader(() => Promise.reject(new Error('no thumbnailer')))
    expect((await loadTrayIcon(rejecting, '/icon.png', 'darwin')).name).toBe('full@resized')
  })

  it('falls back to the in-process decode when the thumbnailer does not answer in time', async () => {
    vi.useFakeTimers()
    const images = loader(() => new Promise<FakeImage>(() => undefined))
    const pending = loadTrayIcon(images, '/icon.png', 'darwin')
    await vi.advanceTimersByTimeAsync(TRAY_THUMBNAIL_TIMEOUT_MS)
    expect((await pending).name).toBe('full@resized')
  })

  it('returns an empty in-process image without resizing it', async () => {
    const empty = image('empty', true)
    const icon = await loadTrayIcon(loader(async () => image('thumb'), empty), '/icon.png', 'linux')
    expect(icon).toBe(empty)
    expect(empty.resize).not.toHaveBeenCalled()
  })
})

describe('loadPresizedTrayIcon (M2-0031, M2-0517)', () => {
  type Representation = { scaleFactor: number; buffer: Buffer }
  type FakeImage = {
    name: string
    isEmpty(): boolean
    resize: Mock<(size: TraySize) => FakeImage>
    addRepresentation: Mock<(options: Representation) => void>
    representations: Representation[]
  }
  const image = (name: string, empty = false): FakeImage => {
    const img: FakeImage = {
      name,
      isEmpty: () => empty,
      resize: vi.fn((_size: TraySize): FakeImage => image(`${name}@resized`)),
      addRepresentation: vi.fn((options: Representation) => void img.representations.push(options)),
      representations: []
    }
    return img
  }
  const PATHS = { presized: '/res/tray/tray.png', fullSize: '/res/icon.png' }
  const PATH_2X = '/res/tray/tray@2x.png'
  const ONE_X = Buffer.from('tray-1x')
  const TWO_X = Buffer.from('tray-2x')
  const EMPTY_PNG = Buffer.from('not-a-png')
  /** A decode of `buffer`: named after its bytes, empty for EMPTY_PNG, holding the 1x representation it came from. */
  const loader = (byPath: Record<string, FakeImage> = {}) => ({
    createThumbnailFromPath: vi.fn(async (_path: string, _size: TraySize) => image('thumb')),
    createFromPath: vi.fn((path: string) => byPath[path] ?? image(`missing:${path}`, true)),
    createFromBuffer: vi.fn((buffer: Buffer, options: { scaleFactor: number }) => {
      const img = image(buffer.toString(), buffer.equals(EMPTY_PNG))
      img.representations.push({ scaleFactor: options.scaleFactor, buffer })
      return img
    })
  })
  const reader = (files: Record<string, Buffer>) =>
    vi.fn(async (path: string) => files[path] ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })))
  const recordingTimer = () => {
    const labels: string[] = []
    const time = <T>(label: string, fn: () => T): T => {
      labels.push(label)
      return fn()
    }
    return { labels, time }
  }

  it.each(['darwin', 'win32', 'linux'] as const)(
    'on %s builds the pre-sized image from its read 1x and 2x bytes, without a path decode, resize or thumbnail',
    async (platform) => {
      const full = image('full')
      const images = loader({ [PATHS.fullSize]: full })
      const read = reader({ [PATHS.presized]: ONE_X, [PATH_2X]: TWO_X })
      const { labels, time } = recordingTimer()

      const icon = await loadPresizedTrayIcon(images, PATHS, platform, time, read)

      expect(read.mock.calls.map(([path]) => path)).toEqual([PATHS.presized, PATH_2X])
      expect(images.createFromBuffer).toHaveBeenCalledExactlyOnceWith(ONE_X, { scaleFactor: 1 })
      expect(icon.name).toBe('tray-1x')
      expect(icon.representations).toEqual([
        { scaleFactor: 1, buffer: ONE_X },
        { scaleFactor: 2, buffer: TWO_X }
      ])
      expect(icon.resize).not.toHaveBeenCalled()
      expect(full.resize).not.toHaveBeenCalled()
      expect(images.createFromPath).not.toHaveBeenCalled()
      expect(images.createThumbnailFromPath).not.toHaveBeenCalled()
      expect(labels).toEqual(['createTray.loadIcon'])
    }
  )

  it('starts both reads before either settles and builds the image only once both have, inside the timed stage', async () => {
    const images = loader()
    const pending: Record<string, (buffer: Buffer) => void> = {}
    const read = vi.fn((path: string) => new Promise<Buffer>((resolve) => (pending[path] = resolve)))
    const events: string[] = []
    const time = <T>(label: string, fn: () => T): T => {
      events.push(`start:${label}`)
      const result = fn()
      events.push(`end:${label}`)
      return result
    }
    images.createFromBuffer.mockImplementation((buffer: Buffer) => {
      events.push('build')
      return image(buffer.toString())
    })

    const loading = loadPresizedTrayIcon(images, PATHS, 'darwin', time, read)
    expect(Object.keys(pending)).toEqual([PATHS.presized, PATH_2X])
    pending[PATHS.presized](ONE_X)
    await yieldToEventLoop()
    expect(events).toEqual([])
    pending[PATH_2X](TWO_X)
    const icon = await loading

    expect(events).toEqual(['start:createTray.loadIcon', 'build', 'end:createTray.loadIcon'])
    expect(icon.addRepresentation).toHaveBeenCalledExactlyOnceWith({ scaleFactor: 2, buffer: TWO_X })
  })

  it('reads the image files with fs.promises by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-tray-'))
    try {
      mkdirSync(join(dir, 'tray'))
      writeFileSync(join(dir, 'tray', 'tray.png'), ONE_X)
      writeFileSync(join(dir, 'tray', 'tray@2x.png'), TWO_X)
      const images = loader()

      const icon = await loadPresizedTrayIcon(images, trayIconPaths(dir), 'win32')

      expect(images.createFromBuffer).toHaveBeenCalledExactlyOnceWith(ONE_X, { scaleFactor: 1 })
      expect(icon.representations).toEqual([
        { scaleFactor: 1, buffer: ONE_X },
        { scaleFactor: 2, buffer: TWO_X }
      ])
      expect(images.createFromPath).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the 1x image alone when the @2x sibling is missing, as the path load did', async () => {
    const images = loader()
    const icon = await loadPresizedTrayIcon(images, PATHS, 'darwin', undefined, reader({ [PATHS.presized]: ONE_X }))

    expect(icon.name).toBe('tray-1x')
    expect(icon.addRepresentation).not.toHaveBeenCalled()
    expect(images.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('falls back to the full-size icon only when the pre-sized image is missing, timing that decode on its own', async () => {
    const full = image('full')
    const images = loader({ [PATHS.fullSize]: full })
    const { labels, time } = recordingTimer()

    const icon = await loadPresizedTrayIcon(images, PATHS, 'win32', time, reader({ [PATH_2X]: TWO_X }))

    expect(icon.name).toBe('full@resized')
    expect(images.createFromBuffer).not.toHaveBeenCalled()
    expect(images.createFromPath.mock.calls.map(([path]) => path)).toEqual([PATHS.fullSize])
    expect(labels).toEqual(['createTray.loadIcon', 'createTray.loadIcon.fallback'])
  })

  it('falls back to the full-size icon when the pre-sized bytes decode to an empty image', async () => {
    const images = loader({ [PATHS.fullSize]: image('full') })

    const icon = await loadPresizedTrayIcon(images, PATHS, 'linux', undefined, reader({ [PATHS.presized]: EMPTY_PNG, [PATH_2X]: TWO_X }))

    expect(icon.name).toBe('full@resized')
    expect(images.createFromPath.mock.calls.map(([path]) => path)).toEqual([PATHS.fullSize])
  })

  it('names the pre-sized image under tray/ and the full-size icon beside it in the resources directory', () => {
    expect(trayIconPaths(join('res'))).toEqual({ presized: join('res', 'tray', 'tray.png'), fullSize: join('res', 'icon.png') })
  })

  it('names the @2x sibling of a PNG as Electron does', () => {
    expect(hiDpiSiblingPath(join('res', 'tray', 'tray.png'))).toBe(join('res', 'tray', 'tray@2x.png'))
  })

  it('buildTrayInStages hands its phase timer to loadIcon, so the icon load is timed as its own phase', async () => {
    const { labels, time } = recordingTimer()
    const images = loader()
    await buildTrayInStages({
      loadIcon: (t) => loadPresizedTrayIcon(images, PATHS, 'darwin', t, reader({ [PATHS.presized]: ONE_X })),
      create: () => undefined,
      decorate: () => undefined,
      buildMenu: () => undefined,
      attachMenu: () => undefined,
      time,
      fail: (error) => {
        throw error
      }
    })
    expect(labels).toEqual([
      'createTray.loadIcon',
      'createTray.newTray',
      'createTray.decorate',
      'createTray.buildMenu',
      'createTray.attachMenu'
    ])
  })

  it('on macOS a missing pre-sized image falls back to the off-thread thumbnail of the full-size icon', async () => {
    const images = loader({})

    const icon = await loadPresizedTrayIcon(images, PATHS, 'darwin', undefined, reader({}))

    expect(icon.name).toBe('thumb')
    expect(images.createThumbnailFromPath).toHaveBeenCalledExactlyOnceWith(PATHS.fullSize, TRAY_ICON_SIZE)
  })
})

describe('formatTrayAccelerator (M2-0515)', () => {
  it('names Windows keys on win32', () => {
    expect(formatTrayAccelerator('CommandOrControl+Shift+Return', 'win32')).toBe('Ctrl+Shift+Enter')
    expect(formatTrayAccelerator('Control+Alt+L', 'win32')).toBe('Ctrl+Alt+L')
    expect(formatTrayAccelerator('Super+Space', 'win32')).toBe('Win+Space')
  })

  it('uses macOS modifier symbols with no separators on darwin', () => {
    expect(formatTrayAccelerator('CommandOrControl+Shift+Return', 'darwin')).toBe('⌘⇧↵')
    expect(formatTrayAccelerator('Alt+Control+L', 'darwin')).toBe('⌥CtrlL')
    expect(formatTrayAccelerator('CmdOrCtrl+Shift+H', 'darwin')).toBe('⌘⇧H')
  })

  it('gives an empty label for an unbound shortcut on every platform', () => {
    expect(formatTrayAccelerator('', 'win32')).toBe('')
    expect(formatTrayAccelerator('', 'darwin')).toBe('')
  })
})
