# Shoey Reference Spec (source for Metis Operator console port)

Source app: local Next.js clone of OpenPanel.dev's Shoey analytics demo, running at
http://127.0.0.1:3112. Pages under `src/app/demo/shoey/*`, components under
`src/components/sites/demo-openpanel-dev-2da6ef64/*` (per-page dirs plus `shared/`),
styling in `src/app/globals.css` (Tailwind v4, CSS-first config, no `tailwind.config.js`).

No theme switcher exists anywhere in this app (grepped for ThemeToggle, useTheme,
next-themes, `dark:` variants: zero hits). A `.dark` class block is defined in
`globals.css` but nothing in the app ever applies it, so there is no dark screenshot
to capture and no dark path a builder needs to support. Treat this app as light-only.

Fonts: no `next/font` and no `@font-face` anywhere. `--font-sans` and `--font-mono`
are both plain system stacks (`ui-sans-serif, system-ui, sans-serif, ...` and
`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, ...`). Nothing loads from
Google Fonts or any CDN. Country flags come from the `flag-icons` npm package
(`flag-icons/css/flag-icons.min.css`, imported once in the root layout) via
`<span className="fi fi-<lowercase-iso2>">`. Brand/OS/browser icons are static PNG/ICO
files under `public/sites/.../shared/images/`, matched by substring against a name
string (see `shared/icons.ts`).

---

## 1. Global tokens (computed, light mode, hex)

Captured with `getComputedStyle` + a canvas round-trip against `:root` in the running
app, so these are exact sRGB values, not eyeballed from the oklch source.

| Token | Hex | Used for |
|---|---|---|
| `--background` | `#ffffff` | Pure white surface (rarely used directly) |
| `--foreground` | `#020819` | Primary text |
| `--card` | `#ffffff` | Card/panel background |
| `--card-foreground` | `#020819` | Text on cards |
| `--popover` | `#ffffff` | Dropdown/menu panel background |
| `--border` | `#e3e8ee` | All hairline borders |
| `--input` | `#e3e8ee` | Input borders (same as border) |
| `--ring` | `#cbd5e1` | Focus ring |
| `--muted` | `#eff5fb` | Muted surface (rarely used) |
| `--muted-foreground` | `#64748b` | Secondary/caption text |
| `--accent` | `#eff5fb` | Hover surface on menu items |
| `--accent-foreground` | `#0f172a` | Text on accent surface |
| `--primary` | `#0f172a` | Primary buttons, active tab underline color source |
| `--primary-foreground` | `#fafafa` | Text on primary buttons |
| `--secondary` | `#eff5fb` | (same as accent) |
| `--destructive` | `#f04343` | Not used as bg directly (delete button uses `bg-red-500`) |
| `--def-100` | `#fafafa` | **Page background** (body, sticky header bg) |
| `--def-200` | `#f4f4f4` | Row hover, active nav item bg, list-card bar fill |
| `--def-300` | `#e3e3e3` | Rarely used divider tone |
| `--def-400` | `#bebebe` | Rarely used |
| `--foregroundish` | `#393939` | Unused softer text tone, present but not referenced in cloned pages |
| `--highlight` | `#2466ea` | Unused accent blue, present but not referenced in cloned pages |
| `--chart-0` | `#2362ee` | Primary chart color: visitor line, mini bar sparklines, map pin fill base |
| `--chart-1` | `#fd775a` | Secondary chart palette (unused in cloned pages) |
| `--chart-2` | `#83e0d8` | Secondary chart palette (unused) |
| `--chart-3` | `#f7bc40` | Secondary chart palette (unused) |
| `--chart-4` | `#b4586e` | Secondary chart palette (unused) |
| `--chart-5` | `#71bef5` | Secondary chart palette (unused) |

Radius scale (base `--radius: 0.5rem` = 8px):
- `--radius-sm` = 0.3rem = 4.8px
- `--radius-md` = 0.4rem = **6.4px** (measured on `.card` directly - this is the card radius, not the base 8px)
- `--radius-lg` = 0.5rem = 8px
- `--radius-xl` = 0.7rem = 11.2px

Typography (measured):
- Base `html`/`body` font-size: 16px, line-height 24px (leading-normal, i.e. 1.5).
- `body` classes: `grainy min-h-screen bg-def-100 font-sans text-base leading-normal antialiased`.
  `grainy` is a subtle background-noise texture utility pulled in from the imported
  `shadcn/tailwind.css` bundle; it is a cosmetic texture only, safe to omit.
- Page `h1` (PageHeader title): 24px / font-weight 700 (`text-2xl font-bold`).
- Page subtitle: 14px, color `--muted-foreground` (`text-sm text-muted-foreground`).
- Table header labels: 10px, uppercase, font-weight 600 (`text-[10px] font-semibold uppercase`).
- Nav labels: 13px, font-weight 500 (`text-[13px] font-medium`).

Layout primitives (custom Tailwind utilities defined in globals.css, not stock classes):
- `.row` = `display:flex; flex-direction:row`
- `.col` = `display:flex; flex-direction:column`
- `.card` = `border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card)`
- `.hide-scrollbar` = scrollbar hidden cross-browser
- `.sticky-header` = `position:sticky; top:0; z-index:20; background:var(--def-100)`

---

## 2. Shell / rail structure (applies to every page)

```
+----------------------------------------------------------------+
| [rail, fixed, 288px, full height]  | [content, lg:pl-72, flex-1]|
|  h-16 header: logo + project pill  |                            |
|  ---------------------------------- |  <page content>            |
|  p-4 nav column (flex-1 overflow):  |                            |
|    [Create report / Ask AI] btn     |                            |
|    [Ask AI anything...] input pill  |                            |
|    "Analytics" label                |                            |
|      Overview / Realtime / Events / |                            |
|      Sessions / Groups              |                            |
|    "Manage" label                   |                            |
|      Settings / Notifications       |                            |
|  ---------------------------------- |                            |
|  footer: Sparkles | User icon row   |                            |
|  "Support Us  Pay What You Want"    |                            |
+----------------------------------------------------------------+
```

Exact measurements:
- Rail: `fixed top-0 left-0 h-screen w-72` (288px), `border-r border-border`, `bg-card`
  (white, not def-100 - the rail is the one full-height surface that stays pure white
  against the off-white page).
- Below `lg` breakpoint the rail translates fully off-canvas (`-translate-x-72`) and a
  hamburger toggle button (`Menu` icon, `aria-label="Toggle menu"`) sits fixed at
  `absolute -right-12` of the rail, vertically centered in a 64px band. Opening it
  slides the rail in and shows a full-viewport `backdrop-blur-sm` scrim button that
  closes it on click.
- Content wrapper: `w-full min-w-0 flex-1 lg:pl-72` - it is NOT a flex sibling with a
  fixed-width column; it's a full-width block padded left by exactly the rail's width
  on large screens. This matters because the rail is `fixed`, so without the matching
  `lg:pl-72` the content would render underneath it.
- Rail header (h-16, border-b): OpenPanel logo image (`max-h-8`, links to `/`), then a
  button styled like an input (`h-8 border border-input bg-card rounded-md`) containing
  a `Building2` icon, the text "Shoey" (project name / switcher trigger), and a
  `ChevronsUpDown` icon pinned right. This is the project switcher - inert in the clone.
- Nav column (`p-4`, scrollable, hidden scrollbar):
  - "Create report" / "Ask AI" button (h-[38px]): label is "Create report" only on
    `/demo/shoey` and `/demo/shoey/realtime`; every other route shows "Ask AI". `Plus`
    icon left, `ChevronDown` icon right.
  - "Ask AI anything..." pill (h-[38px], `border border-border bg-def-100`): `Sparkles`
    icon, text input, `⌘J` kbd hint right-aligned.
  - Section label "Analytics" (`text-sm text-muted-foreground font-medium`), then nav
    links: Overview (`Wallpaper`), Realtime (`Earth`), Events (`ChartNoAxesGantt`),
    Sessions (`Users`), Groups (`Building2`).
  - Section label "Manage", then: Settings (`Cog`), Notifications (`Bell`).
  - Active item background is `--def-200`, applied via a single scoped selector on the
    nav container (`[&_a[data-status='active']]:bg-def-200`) reading a `data-status`
    attribute on the active `<Link>`, not a per-item conditional class string.
- Rail footer: a gradient fade (`from-card to-card/0`, 32px tall) sits above a
  `border-t bg-card` block containing two icon buttons (`Sparkles`, `User`) separated
  by a vertical divider (`divide-x divide-border`), then a centered caption row
  "Support Us" / "Pay What You Want" in muted-foreground text-sm.

**Only 7 routes are real pages in this clone**: `/demo/shoey`, `/demo/shoey/realtime`,
`/demo/shoey/events/events`, `/demo/shoey/sessions`, `/demo/shoey/groups`,
`/demo/shoey/notifications/notifications`, `/demo/shoey/settings/details` (plus 3 bare
paths that redirect to a sub-route default: `/events`, `/notifications`, `/settings`).
Every other nav item, tab, or link the source app has (Conversions, Stats, Rules, every
settings sub-tab except Details) renders visually identical but inert: `opacity-60`,
`cursor-default`, `title="Not part of this clone"`, and does not navigate. This mirrors
exactly how Metis should render any concept it has no backing data for: visible in the
UI (so the layout looks complete) but explicitly inert, never a fake link to nowhere.

---

## 3. Page-by-page

### 3.1 Overview - `/demo/shoey`

```
[sticky toolbar, bg def-100, z-20]
 [Date range v] [Interval v] [Filters v] [ "Try: ..." suggestion pill ]      [• N live] [Private v]
--------------------------------------------------------------------------------------------------
[ grid-cols-6, gap-4, p-4 ]
 col-span-6: [ MetricTiles: 4-col x 2-row grid of 8 tiles, divided borders ]
             [ VisitorsChart: full-width line chart card ]
 col-span-3: [ Refs card ]        col-span-3: [ Pages card ]
 col-span-3: [ Devices card ]     col-span-3: [ Events card ]
 col-span-3: [ Countries card ]
 col-span-6: [ CountryMap: full-width choropleth ]
```

DOM order: `OverviewToolbar` -> `MetricTiles` -> `VisitorsChart` -> `RefsCard` ->
`PagesCard` -> `DevicesCard` -> `EventsCard` -> `CountriesCard` -> `CountryMap`.

**OverviewToolbar** (`sticky-header -top-px`, `p-4 gap-2`):
- Left group: `DateRangeMenu` pill (`Calendar` icon + label, default "Last 7 days"),
  `IntervalMenu` pill (`Clock` icon + "Day"/"Week"/etc), `FilterMenu` pill (`Filter`
  icon + "Filters" + active-count badge chip), then a disabled-looking wide
  (`w-72`) muted pill with a `Sparkles` icon reading
  `Try: "last 7 days, mobile only"` (lowercased current range).
- Right group: a live-count pill (pinging green dot + `AnimatedNumber`, title
  "Visitors online right now"), then a primary filled pill-button
  (`bg-primary text-primary-foreground`) toggling "Private"/"Public" visibility
  (`Lock`/`Globe` icon + label + `ChevronsUpDown`).

**MetricTiles**: one `.card` containing an internal `grid grid-cols-2 md:grid-cols-4
divide-x divide-y divide-border` of 8 cells (not 8 separate cards). 7 data tiles plus 1
live tile:
1. UNIQUE VISITORS - 55.7K, -8.9%
2. SESSIONS - 55.8K, -8.9%
3. PAGEVIEWS - 231K, -8.9%
4. PAGES PER SESSION - 4.1, +0%
5. BOUNCE RATE - 28.70%, +0.5%
6. SESSION DURATION - 18s, +0.1%
7. REVENUE - 0$, +0%
8. LIVE - 30 MIN - live-updating count, pinging dot instead of a delta chip

Each cell: label (11px uppercase muted) + delta chip (`ArrowUp`/`ArrowDown` +
percent, green `bg-emerald-50 text-emerald-600` or red `bg-red-50 text-red-600`) on
one row; big value (`text-2xl font-bold`) with an optional suffix; a small muted range
caption ("Last 7 days"); an 8-bar SVG sparkline (`fill-chart-0`) below.

**VisitorsChart**: `.card p-4`, title "Unique Visitors" (muted, text-sm). SVG,
`viewBox="0 0 1080 170"`, y-gridlines/labels at 0/2k/4k/6k/8k, x-axis date labels every
other data point (`MMM d` format), a soft gradient-filled area under the current-period
line (`chart-0` at 18% opacity fading to 0), a dashed previous-period line
(`stroke-dasharray 4 4`, 45% opacity), and a solid 2px current-period line, all in
`--chart-0` (#2362ee).

**TopListCard family** (`RefsCard`, `PagesCard`, `DevicesCard`, `EventsCard`,
`CountriesCard`): one generic component, config-driven. Each is `.card self-start`:
- Tab row (`border-b`, 12px gap-4, each tab `py-3 text-sm font-medium`, active tab
  `text-foreground border-b-2 border-foreground -mb-px`).
  - Refs tabs: Refs / Urls / Types / Source / Medium / Campaign / Term / Content
  - Pages tabs: Pages / Entries / Exits
  - Devices tabs: Devices / Browser / Browser Version / OS / OS Version / Brands / Models
  - Events tabs: Events / Link out
  - Countries tabs: Countries / Regions / Cities
- Search row (`border-b`, `Search` icon + text input).
- Column header row: label header left, 1 or 2 right-aligned sortable value headers
  with `ChevronDown` (active sort) or `ChevronsUpDown` (inactive). Grid template is
  **`1fr 70px` when there is one value column (Events) and `1fr 70px 70px` when there
  are two (Views/Sess. on every other card)** - do not hardcode 3 columns everywhere.
- Data rows (25px tall): a proportional background bar (`bg-def-200`, hover
  `bg-blue-200`) sized to `value / max * 100%` sits behind the row; icon (brand favicon,
  device type icon, or flag) + truncated label on the left, compact-formatted
  (`56K`/`4.1`) numeric values right-aligned in `font-mono`.
- Footer row (`border-t`): a `Scan` icon on the left, and an optional right-aligned
  action (`ChartLine` icon on Refs/Devices, "Show domain" text+icon on Pages, nothing
  on Events/Countries).

**CountryMap**: `.card`, header row "Map" (muted-foreground). A `MapCanvas` (pannable/
zoomable SVG, 520x300 viewBox) drawing a `geoMercator().translate([260,180]).scale(70)`
projection of world countries, each filled by an oklch-blue intensity scale keyed to
that country's event share (`sqrt(count/max)` interpolation, 12%-100% opacity), white
0.5px country borders, and invisible (`r=0`) hover targets on every country that has
data, showing a tooltip with country name + "N events".

**Metis mapping - Overview**
| Shoey concept | Metis data |
|---|---|
| Visitors | Live seats |
| Sessions | Seat sessions (heartbeat runs) |
| Pageviews | Asks / heartbeats / recaps (activity) |
| Pages per session | omit (no Metis equivalent) |
| Bounce rate | omit (no Metis equivalent - no single-hit session concept) |
| Session duration | Time saved |
| Revenue | D1 ask cost (list price) |
| Live 30 min tile | Live seats right now (from heartbeat stream) |
| Refs / Urls / UTM tabs | omit - not applicable, never fake |
| Pages / Entries / Exits | omit - not applicable |
| Devices / Browser / OS tabs | OS + app version (from heartbeat payload) |
| Events tab | Ingest events (heartbeat, ask, recap, listen, rating, crm, vault, license, seat) |
| Countries / Regions / Cities | `request.cf` geo (Cloudflare edge geo on ingest) |
| Country choropleth map | Same: `request.cf` geo aggregated by country |

### 3.2 Realtime - `/demo/shoey/realtime`

Desktop (`md:` and up):
```
[ full-bleed world map, aspect 2:1, rounded, p-4 pb-0 wrapper ]
[ VisitorsCard w-72 ] [ LiveVisitorsCard w-52 ] [ LiveFeed max-w-lg h-220px ]   (row, gap-4)
[ GeoTable, full width, p-4 pt-4 md:p-8 md:pt-0 ]
```
Mobile (below `md`): stacked column, `p-4 gap-4`: VisitorsCard, LiveVisitorsCard,
WorldMap (`aspect-square`, bled to the viewport edge with `-mx-4`), LiveFeed
(`min-h-[320px]`), GeoTable.

Note for the builder: the *original* OpenPanel source floats VisitorsCard/LiveFeed as
an absolutely-positioned overlay on top of the map. This clone deliberately does not:
it stacks them beside/below the map instead, specifically so the map is never
obscured. Keep that same non-overlay stacking in Metis - don't "fix" it back to an
overlay.

- **VisitorsCard**: `.card bg-background/90 p-4 w-72`. Title "Unique visitors last 30
  min", a pulsing dot while refreshing, a giant `font-bold font-mono text-6xl`
  `AnimatedNumber`, and a 30-bar SVG bar chart below (254x42 viewBox, 6px bars).
- **LiveVisitorsCard**: same card treatment, title "Live" + pinging green dot, giant
  mono number, caption "Visitors online now" + a small pulse dot while refreshing.
- **WorldMap**: `MapCanvas`, 1152x576 viewBox, `geoMercator().translate([576,288])
  .scale(152.948)`. One dot per reporting location (~159 total, tiny filled circles,
  `var(--primary)` at 90% opacity) plus greedily-clustered badge pills on the busiest
  locations (pinging dot + count + place name, rendered as a `foreignObject` that
  counter-scales against the current zoom level so it never distorts). A bottom
  gradient fade (`from-def-100 to-transparent`, 10% of height) blends the map into the
  page.
- **LiveFeed**: `.card col h-full overflow-hidden`. Header "Live events" + pinging dot
  + row count. Scrollable list, 44px rows, divided by hairlines: a colored icon badge
  by event kind (`view`=blue `MonitorPlay`, `session`=emerald `Activity`,
  `commerce`=amber `ShoppingCart`, `other`=neutral `Zap`), the primary label (page path
  for views, humanized event name otherwise), then country flag + OS icon + browser
  icon + device icon (`Smartphone`/`Monitor`) clustered right, then a compact relative
  age ("3s", "2m", "1h") at the far right. New rows fade+slide in from the top on
  arrival (keyed by content, not array index, so the animation doesn't restart on
  every 5s poll).
- **GeoTable** (a `MetricTable` instance titled "Geo"): header row shows up to 8
  country-flag icons for the countries represented. Table grid
  (`1fr auto auto auto`): Country/City (always visible) + Duration (only past 650px
  container width) + Events (sortable, only past 350px) + Sessions (sortable, only
  past 150px) - these are CSS container-query breakpoints on the table's own width,
  not the viewport. Rows are 32px tall with the same proportional-bar-behind-label
  treatment as the overview list cards.

**Metis mapping - Realtime**
| Shoey concept | Metis data |
|---|---|
| Unique visitors last 30 min | Live seats active in the last 30 min |
| Live visitors now | Live seats right now |
| World map dots/badges | `request.cf` geo per active heartbeat, clustered |
| Live events feed | Ingest events (heartbeat, ask, recap, listen, rating, crm, vault, license, seat) |
| Event "device" (mobile/desktop icon) | omit or map to OS if truly available; do not fabricate a device-type signal Metis doesn't collect |
| Geo table (Country/City, Duration, Events, Sessions) | `request.cf` geo, time saved, ingest events, seat sessions |
| Referrals table (present in source, not in this clone) | omit - not applicable |
| Paths table (present in source, not in this clone) | omit - not applicable |

### 3.3 Events - `/demo/shoey/events` (redirects to `/demo/shoey/events/events`)

```
[ PageHeader: "Events" / subtitle, tabs: Events* / Conversions / Stats ]
[ Toolbar: (Listening/Paused) [Date range v] [Filters v]           [View v] ]
[ DataTableClient: Created at | Name | Profile | Country | OS | Browser ]
```
- Listening toggle: a bordered pill button that flips between a pinging green dot +
  "Listening" and a plain gray dot + "Paused"; toggling it turns the 5s poll on/off.
- Table rows are 41px. Name column shows a colored icon-by-kind square (same kind
  logic as the realtime feed) plus the page path (for `screen_view`) or a humanized
  event name. Row click opens a right-side `DetailDrawer` (384px wide, slides in) with
  ID / Name / Created at / Profile ID / Country / City / OS / Browser / Path.
- Conversions and Stats tabs are inert (not part of this clone).
- Empty state: dashed-circle icon + "No events found" / "Nothing matches the current
  filters."

**Metis mapping - Events**
| Shoey concept | Metis data |
|---|---|
| Event name/kind | Ingest event type (heartbeat, ask, recap, listen, rating, crm, vault, license, seat) |
| Listening/Paused live toggle | Same concept: pause/resume the live ingest tail |
| Profile | Hostname, else SSO email if present |
| Country / City | `request.cf` geo |
| OS / Browser | OS + app version from heartbeat payload; "Browser" has no Metis equivalent for a desktop client, omit or repurpose as app version |
| Path (screen_view) | omit - no page-view concept in Metis; use the event's specific payload summary instead |

### 3.4 Sessions - `/demo/shoey/sessions`

```
[ PageHeader: "Sessions" / subtitle, no tabs ]
[ Toolbar: [Search s...] [Filters v]                               [View v] ]
[ DataTableClient: Started | Session ID | Profile | Entry page | Exit page | Duration | Bounce | Referrer ]
```
- Search box here is a hand-rolled copy of the shared pill (the shared `ToolbarSearch`
  has no controlled value, so this page reimplements it locally) - functionally
  identical, worth noting only so a builder doesn't go looking for a second shared
  component.
- Duration column formats as `12.3s`. Bounce is Yes (amber) / No (emerald). Referrer
  shows a brand favicon + name, or "Direct" with no icon.
- Row click opens the same `DetailDrawer` pattern with Session ID / Profile ID /
  Started / Entry page / Exit page / Duration / Bounce / Referrer.
- Empty state: "No sessions found" / "Nothing matches the current search and filters."

**Metis mapping - Sessions**
| Shoey concept | Metis data |
|---|---|
| Session | Seat session (heartbeat run) |
| Started / Duration | Session start time / time saved |
| Entry page / Exit page | omit - not applicable, no page concept |
| Bounce | omit - no single-hit-session concept in Metis |
| Referrer | omit - not applicable, never fake |
| Profile | Hostname, else SSO email if present |

### 3.5 Groups - `/demo/shoey/groups`

```
[ PageHeader: "Groups" / subtitle          [+ Add group] ]
[ Toolbar: [Search ...]                              [View] ]
[ WideTable: Name | ID | Type | Members | Last active | Created ]
  -> always empty in this clone: EmptyState "No groups found"
```
All 6 columns are equal-width (`1fr`). "Add group" is a primary filled button
(`Plus` icon). This page is always empty (`rows: []`) even in the live demo.

**Metis mapping - Groups**
Groups (companies/teams an event belongs to) has no natural Metis equivalent by
default. If Metis has a real grouping axis, the closest natural candidates are OS,
app version, or license state - but per the brief, only map this if there is a
genuine grouping concept; otherwise mark the whole page **omit** (still render the
inert empty-state shell so the nav item isn't a dead link, exactly as this clone
does with its own out-of-scope tabs).

### 3.6 Notifications - `/demo/shoey/notifications` (redirects to
`/demo/shoey/notifications/notifications`)

```
[ PageHeader: "Notifications" / subtitle, tabs: Notifications* / Rules ]
[ Toolbar: [Search] [Created at v]                          [View v] ]
[ WideTable: Title | Integration | Country | OS | Browser | Profile* | Created at ]
  -> always empty in this clone: EmptyState "No data"
```
"Profile" is the one sortable column (`sortable: true`). "Rules" tab is inert.

**Metis mapping - Notifications**
| Shoey concept | Metis data |
|---|---|
| Notification rows (generic) | Seat pending, CRM failed, skill pending, license expiring, platform |
| Integration | The failing/pending subsystem (CRM, license, seat, skill, platform) |
| Country / OS / Browser | `request.cf` geo / OS+app version / omit (no browser concept) |
| Profile | Hostname, else SSO email if present |

### 3.7 Settings - `/demo/shoey/settings` (redirects to `/demo/shoey/settings/details`)

```
[ PageHeader: "Project settings" / subtitle
  tabs: Details* / Events / Clients-API keys / Tracking script / MCP / Widgets / Imports / Google Search ]
[ max-w-3xl content, col gap-6 ]
  [ Card "Details" ]
    Name (readonly text input, "Shoey")
    Domain (toggle switch, blue-600, thumb translate-x-4) + readonly input "https://nike.com"
    Allowed domains (chip "Allow all domains" with X, + "Add a domain (enter)" hint)
    Cross domain support (bordered checkbox card + description)
    Revenue tracking (bordered checkbox card + description, ""unsafe" revenue tracking")
    [Save] (primary button, Save icon)
  [ Card "Delete Project" ]
    warning paragraph (muted-foreground)
    [Delete Project] (red-500 button, Trash2 icon)
```
Every field is `readOnly`/inert in this clone (it's a display-only settings mock). Only
the "Details" tab is real; the other 7 tabs are inert placeholders for
out-of-scope settings sections.

**Metis mapping - Settings**
This is a project/tenant configuration screen, not an analytics view. Map "Details"
to Metis's own tenant/org settings (name, allowed hostnames/domains equivalent to
"allowed domains", any org-level toggles Metis has). Revenue tracking and cross-domain
support are OpenPanel-specific concepts with no Metis equivalent - omit both rather
than inventing settings Metis doesn't have.

---

## 4. The 10 layout rules a builder must not get wrong

1. **Page background is `--def-100` (#fafafa), not `--background` (#fff).** Only the
   rail, cards, and popovers are pure white; the page canvas behind them is off-white.
   Getting this backwards makes every card blend into the page.
2. **Card radius is 6.4px (`--radius-md`, `radius * 0.8`), not the base 8px `--radius`.**
   Measured directly off a live `.card` element. Using the base radius everywhere makes
   corners visibly too round.
3. **The rail is `fixed` + 288px wide, and content is offset with `lg:pl-72` padding, not
   a flex sibling.** Below `lg` the rail translates fully off-canvas and content goes
   full width; a flex-based two-column layout will not reproduce the mobile collapse
   or the hamburger-overlay behavior correctly.
4. **List-card and table row heights are not uniform across the app**: 25px in the
   overview's `TopListCard` rows, 41px in `DataTableClient` rows (Events/Sessions),
   32px in `MetricTable`/`GeoTable` rows, 38px in the two rail action buttons. Pick the
   row height per component family, not one constant everywhere.
5. **`TopListCard`'s column grid changes shape by card**: `1fr 70px` when there is one
   value header (Events tab) vs `1fr 70px 70px` when there are two (every other tab).
   Hardcoding 3 columns breaks the Events card's alignment.
6. **MetricTiles is one card with an internal divided grid (`grid-cols-2 md:grid-cols-4
   divide-x divide-y`), not 8 separate cards.** The dividers between tiles are internal
   borders, and the grid legitimately wraps to 2 rows of 4 on desktop (7 metrics + 1
   live tile).
7. **The realtime desktop map does not float content on top of it.** The upstream
   OpenPanel source overlays the visitor/live/feed column on the map; this clone
   deliberately stacks it below instead so the map is never obscured. Preserve that
   choice in Metis - it is a correction, not an oversight.
8. **GeoTable's extra columns (Duration/Events/Sessions) hide by *container* width, not
   viewport width** (`@container` queries at 650px/350px/150px against the table's own
   box). A `md:`/`lg:` viewport breakpoint will not reproduce this - it must respond to
   the panel's own width, e.g. when it sits in a narrower dashboard slot.
9. **Sidebar active-state and inert-route styling are both applied once, structurally**
   (a single `[&_a[data-status='active']]:bg-def-200` selector; a single
   `isImplemented(href)` check that swaps a `<Link>` for an inert `<span
   opacity-60>`), not per-item conditionals scattered through the nav list. Any route
   Metis doesn't back with real data should render exactly this way: visible, styled
   identically, but inert - never a broken link, never silently removed from the nav.
10. **Only 7 destinations are real; every other nav item, tab, and settings sub-tab is
    inert by design**, matching the required "mark it omit" discipline for Metis
    concepts with no data equivalent (referrers, UTM, paths, groups-if-none, browser
    identity, etc.). Do not invent working pages or fake data to fill these in.

---

## 5. Files in this reference

- `overview-1440.png` / `overview-390.png` - Overview page, desktop + mobile
- `realtime-1440.png` / `realtime-390.png` - Realtime page, desktop + mobile
- `events-1440.png` / `events-390.png` - Events page, desktop + mobile
- `sessions-1440.png` / `sessions-390.png` - Sessions page, desktop + mobile
- `groups-1440.png` / `groups-390.png` - Groups page, desktop + mobile
- `notifications-1440.png` / `notifications-390.png` - Notifications page, desktop + mobile
- `settings-1440.png` / `settings-390.png` - Settings page, desktop + mobile
- `*.snapshot.md` - accessibility tree snapshot per page (desktop viewport)
- `reference-styles/globals.css` - the app's full Tailwind v4 theme + tokens, verbatim
- `reference-styles/utils.ts` - the `cn()` classname helper (clsx + tailwind-merge)

No dark-mode screenshots were produced: the app has no theme switch anywhere in its
UI, so there is nothing to toggle (see the note at the top of this document).

A pre-existing `data/countries-50m.json` file was already present in this output
directory before this task started; it was left untouched and is not part of this
deliverable.
