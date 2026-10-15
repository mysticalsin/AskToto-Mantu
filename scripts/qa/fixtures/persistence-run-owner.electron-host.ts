import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE_FIXTURE_ELECTRON_VERSION = '0.0.0-qa-source-fixture'

if (!process.versions.electron) {
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    enumerable: true,
    value: SOURCE_FIXTURE_ELECTRON_VERSION
  })
}

let userDataPath = process.argv[2] ?? ''

export function setQaFixtureUserDataPath(path: string): void {
  userDataPath = path
}

export const app = Object.freeze({
  isPackaged: true,
  getName: () => 'asktoto-qa',
  getPath: (name: string) => {
    if (name !== 'userData' || !userDataPath) throw new Error('QA fixture userData path is unavailable')
    return userDataPath
  },
  hasSingleInstanceLock: () => true
})

function refuseSourceFixtureNativeEffect(): never {
  throw new Error('QA_SOURCE_FIXTURE_NATIVE_EFFECT_UNAVAILABLE')
}

// Imported production modules may inspect availability. These source fixtures cannot
// encrypt, decrypt, or open a browser; native acceptance uses the installed application.
export const safeStorage = Object.freeze({
  isEncryptionAvailable: () => false,
  encryptString: refuseSourceFixtureNativeEffect,
  decryptString: refuseSourceFixtureNativeEffect
})

export const shell = Object.freeze({
  openExternal: refuseSourceFixtureNativeEffect
})

class QaFixtureMainFrame {
  readonly processId = 1
  readonly routingId = 1
  readonly parent = null
}

export class QaFixtureWebContents extends EventEmitter {
  readonly mainFrame = new QaFixtureMainFrame()
  private destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return pathToFileURL(join(__dirname, '../renderer/index.html')).href
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

export class QaFixtureBrowserWindow extends EventEmitter {
  readonly webContents = new QaFixtureWebContents()
  private destroyed = false
  private visible = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  show(): void {
    this.visible = true
    this.emit('show')
  }

  hide(): void {
    this.visible = false
    this.emit('hide')
  }

  commitInitialMainDocument(): void {
    this.webContents.emit('did-navigate')
  }

  navigateMainDocument(): void {
    this.webContents.emit('did-start-navigation', {}, this.webContents.getURL(), false, true)
  }

  loseRendererProcess(): void {
    this.webContents.emit('render-process-gone')
  }

  finishMainNavigation(): void {
    this.webContents.emit('did-navigate')
  }

  destroy(): void {
    this.destroyed = true
    this.emit('closed')
    this.webContents.destroy()
  }
}
