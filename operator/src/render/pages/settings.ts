/**
 * Settings page (plan 6.11). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour.
 * The full tabbed Settings (Tiers, Value, Skills, Questions, Platform health, Audit log,
 * Session, Appearance) lands in P1.10; this keeps the three rule cards that already exist.
 */
import type { DashboardPayload } from '../../dashboard'
import { pageHeader, type RenderCtx } from '../index'

export function renderSettings(_data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Settings', subtitle: 'Operator configuration.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Settings</p>
      <div class="rule"><h3>Access keep</h3><p>Cloudflare Access email-code only. Allowlist tony.walteur@gmail.com and twalteur@amaris.com. No homemade login.</p></div>
      <div class="rule"><h3>Generate license</h3><p>Licenses → duration → Generate license. Paste the once-string into Métis → Settings → Operator → Operator license. last4 after reload.</p></div>
      <div class="rule"><h3>Geo</h3><p>City / region / country come from request.cf on heartbeat. Never client GPS. Never IP.</p></div>
      <p id="key-msg-settings" class="muted"></p>
    </article>`
}
