import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  attachMenuOnFirstOpen,
  buildTrayInStages,
  createSingleFlight,
  formatTrayAccelerator,
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

  it('buildTrayInStages loads the icon, creates the tray and attaches the menu in three separate tasks', async () => {
    const order: string[] = []
    const labels: string[] = []
    const fail = vi.fn()
    const done = buildTrayInStages<string>({
      loadIcon: async () => {
        order.push('load')
        return 'icon'
      },
      create: (icon) => order.push(`create:${icon}`),
      attachMenu: () => order.push('menu'),
      time: (label, fn) => {
        labels.push(label)
        return fn()
      },
      fail
    })
    // Every stage boundary is a task boundary: an immediate queued now runs before the tray is created,
    // and one queued after the create runs before the menu is attached.
    setImmediate(() => {
      order.push('between-load-and-create')
      setImmediate(() => order.push('between-create-and-menu'))
    })
    await done
    expect(order).toEqual(['load', 'between-load-and-create', 'create:icon', 'between-create-and-menu', 'menu'])
    expect(labels).toEqual(['createTray.newTray', 'createTray.attachMenu'])
    expect(fail).not.toHaveBeenCalled()
  })

  it('buildTrayInStages runs decorate and buildMenu, when given, each in a task of its own and timed under its own label (M2-0433)', async () => {
    const order: string[] = []
    const labels: string[] = []
    const done = buildTrayInStages<string>({
      loadIcon: async () => 'icon',
      create: () => {
        order.push('create')
        setImmediate(() => order.push('task-after-create'))
      },
      decorate: () => {
        order.push('decorate')
        setImmediate(() => order.push('task-after-decorate'))
      },
      buildMenu: () => {
        order.push('buildMenu')
        setImmediate(() => order.push('task-after-buildMenu'))
      },
      attachMenu: () => order.push('attachMenu'),
      time: (label, fn) => {
        labels.push(label)
        return fn()
      },
      fail: (error) => {
        throw error
      }
    })
    await done
    expect(order).toEqual(['create', 'task-after-create', 'decorate', 'task-after-decorate', 'buildMenu', 'task-after-buildMenu', 'attachMenu'])
    expect(labels).toEqual(['createTray.newTray', 'createTray.decorate', 'createTray.buildMenu', 'createTray.attachMenu'])
  })

  it('buildTrayInStages hands the loaded icon to decorate and the built menu to attachMenu (M2-0433)', async () => {
    const decorate = vi.fn()
    const attachMenu = vi.fn()
    await buildTrayInStages<string, { items: number }>({
      loadIcon: async () => 'icon',
      create: vi.fn(),
      decorate,
      buildMenu: () => ({ items: 3 }),
      attachMenu,
      time: (_label, fn) => fn(),
      fail: (error) => {
        throw error
      }
    })
    expect(decorate).toHaveBeenCalledExactlyOnceWith('icon')
    expect(attachMenu).toHaveBeenCalledExactlyOnceWith({ items: 3 })
  })

  it('buildTrayInStages attaches with no prebuilt menu when there is no buildMenu stage (M2-0433)', async () => {
    const attachMenu = vi.fn()
    await buildTrayInStages<string, string>({
      loadIcon: async () => 'icon',
      create: vi.fn(),
      attachMenu,
      time: (_label, fn) => fn(),
      fail: (error) => {
        throw error
      }
    })
    expect(attachMenu).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('buildTrayInStages reports a failing stage once and runs no later stage', async () => {
    const attachMenu = vi.fn()
    const fail = vi.fn()
    await buildTrayInStages<string>({
      loadIcon: async () => 'icon',
      create: () => {
        throw new Error('status item refused')
      },
      attachMenu,
      time: (_label, fn) => fn(),
      fail
    })
    expect(attachMenu).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledExactlyOnceWith(new Error('status item refused'))
  })

  it('buildTrayInStages reports an icon load rejection without creating a tray', async () => {
    const create = vi.fn()
    const fail = vi.fn()
    await buildTrayInStages<string>({
      loadIcon: () => Promise.reject(new Error('decode failed')),
      create,
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

describe('loadPresizedTrayIcon (M2-0031)', () => {
  type FakeImage = { name: string; isEmpty(): boolean; resize: Mock<(size: TraySize) => FakeImage> }
  const image = (name: string, empty = false): FakeImage => ({
    name,
    isEmpty: () => empty,
    resize: vi.fn((_size: TraySize): FakeImage => image(`${name}@resized`))
  })
  const PATHS = { presized: '/res/tray/tray.png', fullSize: '/res/icon.png' }
  const loader = (byPath: Record<string, FakeImage>) => ({
    createThumbnailFromPath: vi.fn(async (_path: string, _size: TraySize) => image('thumb')),
    createFromPath: vi.fn((path: string) => byPath[path] ?? image(`missing:${path}`, true))
  })
  const recordingTimer = () => {
    const labels: string[] = []
    const time = <T>(label: string, fn: () => T): T => {
      labels.push(label)
      return fn()
    }
    return { labels, time }
  }

  it.each(['darwin', 'win32', 'linux'] as const)('on %s loads the pre-sized image without resizing or thumbnailing', async (platform) => {
    const presized = image('tray')
    const full = image('full')
    const images = loader({ [PATHS.presized]: presized, [PATHS.fullSize]: full })
    const { labels, time } = recordingTimer()

    const icon = await loadPresizedTrayIcon(images, PATHS, platform, time)

    expect(icon).toBe(presized)
    expect(presized.resize).not.toHaveBeenCalled()
    expect(full.resize).not.toHaveBeenCalled()
    expect(images.createFromPath).toHaveBeenCalledExactlyOnceWith(PATHS.presized)
    expect(images.createThumbnailFromPath).not.toHaveBeenCalled()
    expect(labels).toEqual(['createTray.loadIcon'])
  })

  it('falls back to the full-size icon only when the pre-sized image is missing, timing that decode on its own', async () => {
    const full = image('full')
    const images = loader({ [PATHS.fullSize]: full })
    const { labels, time } = recordingTimer()

    const icon = await loadPresizedTrayIcon(images, PATHS, 'win32', time)

    expect(icon.name).toBe('full@resized')
    expect(images.createFromPath.mock.calls.map(([path]) => path)).toEqual([PATHS.presized, PATHS.fullSize])
    expect(labels).toEqual(['createTray.loadIcon', 'createTray.loadIcon.fallback'])
  })

  it('names the pre-sized image under tray/ and the full-size icon beside it in the resources directory', () => {
    expect(trayIconPaths(join('res'))).toEqual({ presized: join('res', 'tray', 'tray.png'), fullSize: join('res', 'icon.png') })
  })

  it('buildTrayInStages hands its phase timer to loadIcon, so the icon load is timed as its own phase', async () => {
    const { labels, time } = recordingTimer()
    const images = loader({ [PATHS.presized]: image('tray') })
    await buildTrayInStages({
      loadIcon: (t) => loadPresizedTrayIcon(images, PATHS, 'darwin', t),
      create: () => undefined,
      attachMenu: () => undefined,
      time,
      fail: (error) => {
        throw error
      }
    })
    expect(labels).toEqual(['createTray.loadIcon', 'createTray.newTray', 'createTray.attachMenu'])
  })

  it('on macOS a missing pre-sized image falls back to the off-thread thumbnail of the full-size icon', async () => {
    const images = loader({})

    const icon = await loadPresizedTrayIcon(images, PATHS, 'darwin')

    expect(icon.name).toBe('thumb')
    expect(images.createThumbnailFromPath).toHaveBeenCalledExactlyOnceWith(PATHS.fullSize, TRAY_ICON_SIZE)
  })
})

describe('buildTrayInStages image and lazy-menu stages (M2-0433)', () => {
  it('gives the bare item its image in a task of its own, and attaches no menu at boot when there is no attachMenu', async () => {
    const order: string[] = []
    const labels: string[] = []
    await buildTrayInStages<string>({
      loadIcon: async () => 'icon',
      create: () => {
        order.push('create')
        setImmediate(() => order.push('task-after-create'))
      },
      setImage: (icon) => {
        order.push(`setImage:${icon}`)
        setImmediate(() => order.push('task-after-setImage'))
      },
      decorate: () => order.push('decorate'),
      time: (label, fn) => {
        labels.push(label)
        return fn()
      },
      fail: (error) => {
        throw error
      }
    })
    expect(order).toEqual(['create', 'task-after-create', 'setImage:icon', 'task-after-setImage', 'decorate'])
    expect(labels).toEqual(['createTray.newTray', 'createTray.setImage', 'createTray.decorate'])
  })
})

describe('attachMenuOnFirstOpen (M2-0433)', () => {
  function fakeTray() {
    const state = { destroyed: false }
    return Object.assign(new EventEmitter(), {
      state,
      isDestroyed: () => state.destroyed,
      setContextMenu: vi.fn<(menu: string | null) => void>(),
      popUpContextMenu: vi.fn<(menu?: string) => void>()
    })
  }

  it.each(['darwin', 'win32'] as const)('on %s builds and attaches nothing until the first right-click, then pops that menu up once', (platform) => {
    const tray = fakeTray()
    const buildMenu = vi.fn(() => 'menu-1')
    const labels: string[] = []
    attachMenuOnFirstOpen(tray, platform, buildMenu, (label, fn) => {
      labels.push(label)
      return fn()
    })
    expect(buildMenu).not.toHaveBeenCalled()
    expect(tray.setContextMenu).not.toHaveBeenCalled()

    tray.emit('right-click')
    expect(buildMenu).toHaveBeenCalledTimes(1)
    expect(tray.setContextMenu).toHaveBeenCalledExactlyOnceWith('menu-1')
    expect(tray.popUpContextMenu).toHaveBeenCalledExactlyOnceWith('menu-1')
    expect(labels).toEqual(['createTray.buildMenu', 'createTray.attachMenu'])

    // Later opens are the native attached menu's own.
    tray.emit('right-click')
    tray.emit('click')
    expect(buildMenu).toHaveBeenCalledTimes(1)
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1)
  })

  it('on macOS attaches the menu without a pop-up when the pointer enters the item, so the next left click opens it natively', () => {
    const mac = fakeTray()
    const buildMenu = vi.fn(() => 'menu')
    const labels: string[] = []
    attachMenuOnFirstOpen(mac, 'darwin', buildMenu, (label, fn) => {
      labels.push(label)
      return fn()
    })
    mac.emit('mouse-enter')
    expect(mac.setContextMenu).toHaveBeenCalledExactlyOnceWith('menu')
    expect(mac.popUpContextMenu).not.toHaveBeenCalled()
    expect(labels).toEqual(['createTray.buildMenu', 'createTray.attachMenu'])

    mac.emit('mouse-enter')
    mac.emit('right-click')
    expect(buildMenu).toHaveBeenCalledTimes(1)
    expect(mac.popUpContextMenu).not.toHaveBeenCalled()
  })

  it('leaves the left click to the caller: a Windows pointer or click attaches nothing and pops nothing up', () => {
    const windows = fakeTray()
    attachMenuOnFirstOpen(windows, 'win32', () => 'menu')
    windows.emit('mouse-enter')
    windows.emit('click')
    expect(windows.setContextMenu).not.toHaveBeenCalled()
    expect(windows.popUpContextMenu).not.toHaveBeenCalled()

    const mac = fakeTray()
    attachMenuOnFirstOpen(mac, 'darwin', () => 'menu')
    mac.emit('click')
    expect(mac.setContextMenu).not.toHaveBeenCalled()
    expect(mac.popUpContextMenu).not.toHaveBeenCalled()
  })

  it('attaches nothing when the pointer enters a destroyed macOS item', () => {
    const mac = fakeTray()
    const buildMenu = vi.fn(() => 'menu')
    attachMenuOnFirstOpen(mac, 'darwin', buildMenu)
    mac.state.destroyed = true
    mac.emit('mouse-enter')
    expect(buildMenu).not.toHaveBeenCalled()
    expect(mac.setContextMenu).not.toHaveBeenCalled()
  })

  it('builds the first menu from the settings current at the first open, so a rebind before it is not lost', () => {
    const tray = fakeTray()
    let shortcut = 'CommandOrControl+Shift+M'
    const menu = attachMenuOnFirstOpen(tray, 'win32', () => `menu(${shortcut})`)
    shortcut = 'CommandOrControl+Shift+K'
    menu.rebuild()
    tray.emit('right-click')
    expect(tray.setContextMenu).toHaveBeenCalledExactlyOnceWith('menu(CommandOrControl+Shift+K)')
    expect(tray.popUpContextMenu).toHaveBeenCalledExactlyOnceWith('menu(CommandOrControl+Shift+K)')
  })

  it('attaches at once where the tray emits no open event', () => {
    const tray = fakeTray()
    attachMenuOnFirstOpen(tray, 'linux', () => 'menu')
    expect(tray.setContextMenu).toHaveBeenCalledExactlyOnceWith('menu')
    expect(tray.popUpContextMenu).not.toHaveBeenCalled()
  })

  it('rebuild does nothing before the first open and replaces the attached menu after it', () => {
    const tray = fakeTray()
    let built = 0
    const menu = attachMenuOnFirstOpen(tray, 'darwin', () => `menu-${++built}`)
    menu.rebuild()
    expect(built).toBe(0)
    expect(tray.setContextMenu).not.toHaveBeenCalled()

    tray.emit('right-click')
    menu.rebuild()
    expect(tray.setContextMenu).toHaveBeenLastCalledWith('menu-2')
  })

  it('does nothing on an open or a rebuild once the tray is destroyed', () => {
    const tray = fakeTray()
    const buildMenu = vi.fn(() => 'menu')
    const menu = attachMenuOnFirstOpen(tray, 'win32', buildMenu)
    tray.state.destroyed = true
    tray.emit('right-click')
    menu.rebuild()
    expect(buildMenu).not.toHaveBeenCalled()
    expect(tray.setContextMenu).not.toHaveBeenCalled()
  })
})

describe('formatTrayAccelerator (M2-0433)', () => {
  it('spells an accelerator with Windows key names on win32', () => {
    expect(formatTrayAccelerator('CommandOrControl+Shift+Return', 'win32')).toBe('Ctrl+Shift+Enter')
    expect(formatTrayAccelerator('Super+Alt+K', 'win32')).toBe('Win+Alt+K')
  })

  it('spells an accelerator with macOS modifier symbols elsewhere', () => {
    expect(formatTrayAccelerator('CommandOrControl+Shift+Alt+Return', 'darwin')).toBe('⌘⇧⌥↵')
    expect(formatTrayAccelerator('Control+K', 'linux')).toBe('CtrlK')
  })

  it('returns an empty label for an unbound shortcut', () => {
    expect(formatTrayAccelerator('', 'darwin')).toBe('')
    expect(formatTrayAccelerator('', 'win32')).toBe('')
  })
})
