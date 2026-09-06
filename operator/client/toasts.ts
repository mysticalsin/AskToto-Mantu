/**
 * Toast notifications (plan 6.1). One at a time: a new toast replaces whatever is showing. `ok`
 * and `info` auto-dismiss after 4s; `error` shows the request id in mono and stays until the
 * operator dismisses it (plan 3.7b law 7: nothing the operator needs to act on disappears on its
 * own). Page modules (P1+) wire their own mutations to `toast()`; nothing in this task calls it
 * yet.
 */

export type ToastKind = 'ok' | 'error' | 'info'

export interface ToastOptions {
  kind: ToastKind
  text: string
  requestId?: string
  undo?: () => void
}

let hideTimer: ReturnType<typeof setTimeout> | null = null

function region(): HTMLElement | null {
  return document.querySelector('[data-toasts]')
}

/** Removes the current toast, if any, before its auto-dismiss timer would have fired. */
export function dismissToast(): void {
  var host = region()
  if (host) host.textContent = ''
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

export function toast(opts: ToastOptions): void {
  var host = region()
  if (!host) return
  dismissToast()

  var el = document.createElement('div')
  el.className = 'toast toast-' + opts.kind
  el.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status')

  var text = document.createElement('span')
  text.className = 'toast-text'
  text.textContent = opts.text
  el.appendChild(text)

  if (opts.requestId) {
    var rid = document.createElement('code')
    rid.className = 'toast-request-id'
    rid.textContent = opts.requestId
    el.appendChild(rid)
  }

  if (opts.undo) {
    var undo = opts.undo
    var undoBtn = document.createElement('button')
    undoBtn.type = 'button'
    undoBtn.className = 'toast-undo'
    undoBtn.textContent = 'Undo'
    undoBtn.addEventListener('click', function () {
      undo()
      dismissToast()
    })
    el.appendChild(undoBtn)
  }

  var closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'toast-close'
  closeBtn.setAttribute('aria-label', 'Dismiss')
  closeBtn.textContent = String.fromCharCode(215)
  closeBtn.addEventListener('click', dismissToast)
  el.appendChild(closeBtn)

  host.appendChild(el)

  if (opts.kind !== 'error') {
    hideTimer = setTimeout(dismissToast, 4000)
  }
}
