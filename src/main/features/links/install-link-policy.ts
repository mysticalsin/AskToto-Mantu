import { shell, type WebContents } from 'electron'
import { LINK_IPC } from '@shared/links'
import { openExternalLink } from './open-external-link'

/**
 * The trusted renderer's link policy (G55): it never navigates away from its own page and never opens a child window
 * (which would inherit the privileged preload). A link leaves only through `openExternalLink`; one that fails tells the
 * renderer so it can show the fixed notice.
 */
export function installLinkPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalLink(url, {
      openExternal: (target) => shell.openExternal(target),
      notifyFailure: () => {
        if (!contents.isDestroyed()) contents.send(LINK_IPC.openFailed)
      }
    })
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
}
