/** Mobile off-canvas rail (menu button + backdrop, SPEC #2) and the Cloudflare-connect
 * return-message banner. Ported from the pre-D3 inline `<script>`. The rail search field itself
 * (`#nav-search`) is owned by operator/client/search.ts, not here. */

/** Below 1024px the rail (`#rail`) is fixed off-canvas; `#rail-toggle` slides it in, and either
 * the backdrop (`#rail-backdrop`) or Escape closes it. */
export function initMobileRail(): void {
  var rail = document.getElementById('rail')
  var toggle = document.getElementById('rail-toggle')
  var backdrop = document.getElementById('rail-backdrop')
  if (!rail || !toggle || !backdrop) return

  function open(): void {
    rail!.classList.add('open')
    backdrop!.setAttribute('data-open', '1')
    toggle!.setAttribute('aria-expanded', 'true')
  }
  function close(): void {
    rail!.classList.remove('open')
    backdrop!.setAttribute('data-open', '0')
    toggle!.setAttribute('aria-expanded', 'false')
  }
  toggle.addEventListener('click', function () {
    if (rail!.classList.contains('open')) close()
    else open()
  })
  backdrop.addEventListener('click', close)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close()
  })
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(function (a) {
    a.addEventListener('click', close)
  })
}

/** The rail's primary action button on Overview/Licenses ("Generate license") jumps to the
 * Licenses page and focuses the duration field. The project pill (`data-rail-pill`) is inert by
 * design (reference SPEC #2: "inert in the clone" - Métis has one project, no switcher). */
export function initRailGenerate(): void {
  var btn = document.querySelector<HTMLElement>('[data-rail-generate]')
  if (!btn) return
  btn.addEventListener('click', function () {
    if (location.hash !== '#licenses') location.hash = '#licenses'
    var select = document.querySelector<HTMLElement>('[data-license-generate] select[name="days"]')
    if (select) select.focus()
  })
}

/** The rail's primary action button on Connectors ("Add connector") jumps to the Connectors page
 * and announces the intent; the Connectors page module (P1.9) opens its own catalog/drawer flow
 * in response instead of this shell task reaching into a page it does not own. */
export function initRailAddConnector(): void {
  var btn = document.querySelector<HTMLElement>('[data-rail-add-connector]')
  if (!btn) return
  btn.addEventListener('click', function () {
    if (location.hash !== '#connectors') location.hash = '#connectors'
    window.dispatchEvent(new CustomEvent('metis:add-connector'))
  })
}

/** After a Cloudflare OAuth round-trip the Worker redirects back with `?cf=connected|failed|
 * denied|need-oauth`; show what happened once, next to the connect button on Keys. */
export function initCloudflareConnectResult(): void {
  var q = new URLSearchParams(location.search).get('cf')
  var el = document.getElementById('cf-connect-msg')
  if (!el || !q) return
  if (q === 'connected') el.textContent = 'AI Gateway key added. last4 only.'
  else if (q === 'failed') el.textContent = 'Cloudflare login worked, but Operator could not provision the key.'
  else if (q === 'denied') el.textContent = 'Cloudflare login was cancelled.'
  else if (q === 'need-oauth') el.textContent = 'Cloudflare OAuth client is missing on this Worker.'
}
