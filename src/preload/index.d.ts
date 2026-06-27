import type { TotoApi } from './index'

declare global {
  interface Window {
    toto: TotoApi
  }
}

export {}
