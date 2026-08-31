# The AskToto License Operator's Handbook

Everything you do as the person running the license business, in one place.
The [README](README.md) documents the software; this documents **your job**.
Each chapter is a task you'll actually perform, with the exact clicks or
commands.

---

## Contents

1. [The 30-second mental model](#1-the-30-second-mental-model)
2. [Your setup — where everything lives](#2-your-setup--where-everything-lives)
3. [The dashboard](#3-the-dashboard)
4. [Selling a license — the core workflow](#4-selling-a-license--the-core-workflow)
5. [Managing a license after the sale](#5-managing-a-license-after-the-sale)
6. [When a customer calls](#6-when-a-customer-calls)
7. [Backups and disaster recovery](#7-backups-and-disaster-recovery)
8. [Discord alerts — what each one means](#8-discord-alerts--what-each-one-means)
9. [Monitoring](#9-monitoring)
10. [CLI and API quick reference](#10-cli-and-api-quick-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Security rules](#12-security-rules)
13. [Moving the server](#13-moving-the-server)
14. [Operating rhythm — the checklists](#14-operating-rhythm--the-checklists)

---

## 1. The 30-second mental model

- Each **company** gets one **license key** (`ATK-` + 20 characters) with a
  **seat cap** — the max number of machines that can run AskToto at once.
- The app on each machine **activates** once (consumes a seat), then quietly
  **heartbeats** every 12 hours to stay valid. Re-activating the same machine
  never consumes a second seat.
- If a machine can't reach your server, the app keeps working on a
  **7-day offline grace** window (inside a 30-day hard cap). So brief server
  downtime never locks a customer out.
- **Revoking** a license blocks every machine on it at the next heartbeat.
  **Expiry** does the same automatically on a date. Freeing a **seat** just
  disconnects one machine.
- Everything lives in one JSON file on the server, snapshotted automatically
  every day. There is no database to manage.

## 2. Your setup — where everything lives

| Thing | Where |
|---|---|
| Server | Docker container `asktoto-license` on this Mac, port `8420` |
| Dashboard | `http://localhost:8420/admin/ui` (this Mac) or `http://192.168.0.38:8420/admin/ui` (LAN) |
| Admin token | `~/AI-Brain-build/asktoto-license/admin-token.txt` |
| Metrics token | `~/AI-Brain-build/asktoto-license/metrics-token.txt` |
| Discord webhook URL | `~/AI-Brain-build/asktoto-license/discord-webhook.txt` |
| Mantu's own license | `~/AI-Brain-build/asktoto-license/mantu-license.txt` |
| License data | Docker volume `asktoto-license-data` (survives container rebuilds) |
| Automatic backups | inside the volume at `/app/data/backups/`, daily, last 30 kept |
| Code | `license-server/` in the AskToto repo |

The container restarts by itself (`unless-stopped`) — after a Mac reboot it
comes back as soon as Docker Desktop is running.

**Recreate the container from scratch** (after a code update, or if it's ever
in a weird state — the data volume is untouched):

```bash
cd "<repo>/license-server"
docker build -t asktoto-license-server .
docker rm -f asktoto-license
docker run -d --name asktoto-license --restart unless-stopped -p 8420:8420 \
  -e LICENSE_ADMIN_TOKEN="$(cat ~/AI-Brain-build/asktoto-license/admin-token.txt)" \
  -e METRICS_TOKEN="$(cat ~/AI-Brain-build/asktoto-license/metrics-token.txt)" \
  -e LICENSE_WEBHOOK_URL="$(cat ~/AI-Brain-build/asktoto-license/discord-webhook.txt)" \
  -v asktoto-license-data:/app/data asktoto-license-server
```

## 3. The dashboard

Open the dashboard URL, paste the admin token once — it's remembered in that
browser until you sign out.

**Three tabs:**

- **Licenses** — the main table. Every license with company, seats used vs.
  cap, activity in the last 30 days, status pill (Active / Revoked /
  Expired), created and expiry dates. Search box filters by company, key, or
  contact; click column headers to sort. Amber rows are expiring within 30
  days; a `FULL` chip means every seat is taken. Click any row to open the
  detail drawer.
- **Analytics** — activations per day (last 30 days), seat utilization per
  company, server version/uptime, last-backup status, and the **Back up
  now** button.
- **Audit log** — every admin action ever taken (create, revoke, edit, seat
  freed, backup, restore), timestamped. Your answer to "wait, what happened
  to this license?"

The summary cards above the table give you the business at a glance: total
licenses, seats in use, active machines, expiring soon, revoked.

## 4. Selling a license — the core workflow

The whole thing is about two minutes:

1. Dashboard → **New license**.
2. Fill in: company name, **seat cap** (how many machines they bought),
   **expiry date** (leave empty for perpetual; set it for subscriptions),
   contact name/email, and any deal notes. Notes are for future-you —
   plan tier, price, renewal terms.
3. **Create license** — the key appears once in a reveal dialog. Copy it.
   (Nothing is lost if you close it; the key stays visible in the table.)
4. Open the new license's drawer → **Copy setup instructions**. That copies
   a ready-to-send block:

   ```
   AskToto setup instructions

   Server URL: <your server url>
   License key: ATK-XXXXXXXXXXXXXXXXXXXX

   1. Open AskToto.
   2. Go to Settings, then About, then License.
   3. Paste the server URL and license key above, then click Activate.
   ```

5. Send that to the customer contact.
6. **Verify it landed:** within a day, the license row shows seats in use go
   from `0 / N` to `1 / N`, `2 / N`... You'll also see it in the Analytics
   activation chart. No Discord message fires for normal activations —
   only for problems (seat cap hit).

Batch-minting or scripting instead? See the CLI in
[chapter 10](#10-cli-and-api-quick-reference).

> ⚠️ **Until customers are outside your LAN**, the server URL only works on
> your network. Before the first real external customer, deploy with the
> [`deploy/`](deploy/README.md) bundle (domain + auto-HTTPS) and give
> customers that domain as the Server URL.

## 5. Managing a license after the sale

Everything below is in the license's detail drawer (click its row):

| Task | How |
|---|---|
| **Add seats** (upsell) | Seat cap field → new number → Save. Takes effect immediately. |
| **Reduce seats** | Same field. Machines already activated stay until you free them. |
| **Extend / set expiry** (renewal) | Expiry date field → pick date → Save. Expiry is end-of-day. An expired license un-expires the moment you set a future date. |
| **Make perpetual** | Clear the expiry date → Save. |
| **Update contact / notes** | Edit the fields → Save. |
| **Free a seat** | Activations list → Free seat next to the machine. Use "last seen" to spot dead machines. The freed machine can re-activate (consuming a seat again) unless you also revoke. |
| **Revoke** (offboarding, non-payment) | Revoke button → confirm. Every machine is blocked at its next heartbeat (within ~12h, or instantly on app restart). Reversible. |
| **Unrevoke** | Same place. Machines revalidate on their own. |
| **Delete** | Only for mis-mints and tests. Real customers get **revoked**, never deleted — revoked keeps the record. Deletion is still traced in the audit log. |

## 6. When a customer calls

**"It says seat limit reached."**
Open their license. Either they genuinely need more seats (sell them — raise
the cap) or an old machine is holding one (check "last seen" in the
activations list, free the stale seat). You may already know before they
call: this is exactly what the amber Discord "Seat cap reached" message is.

**"It says our license expired."**
Renewal conversation. When settled: drawer → set new expiry date → Save.
Their machines revalidate automatically — nothing to do on their side.

**"It says invalid license."**
The key is mistyped or the Server URL is wrong. Re-send with **Copy setup
instructions** — it contains both, exactly right.

**"We lost our license key."**
It's in your table. Open the license → copy the full key (or the whole setup
block) and re-send. Keys are never hidden from you.

**"We replaced a laptop."**
Free the old machine's seat; they activate on the new one. Seat count stays
the same.

**"Does it work offline / when your server is down?"**
Yes — 7 days fully offline, no questions asked. Past that the app asks to
reconnect once.

**"Remove machine X right now"** (lost/stolen laptop)
Free its seat, and if the situation is hostile, revoke the license until
things are sorted — a freed machine can otherwise just re-activate.

## 7. Backups and disaster recovery

**What happens by itself:** every 24 h (and at every server start) the
server snapshots the entire license store into its data volume; the last 30
snapshots are kept. Identical-data snapshots are skipped. You can see the
last snapshot time on the Analytics tab.

**Before anything risky** (a restore, a migration, bulk edits): Analytics →
**Back up now**. It always writes a fresh snapshot.

**Weekly habit (recommended):** pull one copy *off this Mac* — on-server
snapshots don't survive the disk dying:

```bash
cd "<repo>/license-server"
node scripts/backup.mjs --url http://localhost:8420 \
  --token "$(cat ~/AI-Brain-build/asktoto-license/admin-token.txt)" \
  --out ~/Documents/asktoto-license-backups
```

**Restoring** (wrong bulk edit, corrupted disk, moving hosts):

```bash
node scripts/restore.mjs --url http://localhost:8420 \
  --token "$(cat ~/AI-Brain-build/asktoto-license/admin-token.txt)" \
  --file <backup-file.json> --yes
```

Restore **replaces everything** — but the server always snapshots the current
data first (`licenses.pre-restore-*.bak`), so even a wrong restore is
recoverable. This exact drill has been run live: backup → wipe → restore →
all seats back. It works.

## 8. Discord alerts — what each one means

| Message | Meaning | Your move |
|---|---|---|
| 🟢 **License created** | You (or a script) minted a license | Sanity check it's expected |
| 🔴 **License revoked** | A license was revoked | Expected? If not — audit log |
| 🟢 **License unrevoked** | Revocation lifted | — |
| 🔴 **License deleted** | A record permanently removed | Should be rare; audit log if surprising |
| 🟡 **Seat cap reached** | A machine tried to activate and bounced (max one alert per license per hour) | Upsell seats, or free a stale seat |
| 🟡 **License expiring soon** | Enters the 14-day window (once per expiry date) | Start the renewal conversation |
| 🟣 **Store restored from backup** | Someone replaced the whole store | Should only ever be you |

License keys in Discord are truncated on purpose — a chat channel never gets
an activatable key.

If alerts stop arriving: the webhook URL may have been regenerated in
Discord. Update `discord-webhook.txt` and recreate the container (chapter 2).

## 9. Monitoring

- **Quick check, no auth:** `curl http://localhost:8420/health` →
  `{ ok, version, uptimeSeconds }`. Fleet counts live on `GET /metrics`
  (bearer `METRICS_TOKEN`), not on public health.
- **Prometheus / Grafana / uptime bots:** `GET /metrics` with
  `Authorization: Bearer <metrics token>` — licenses by status, seats used
  vs. cap, expiring-soon count, uptime. Scrape config is in the README's
  Monitoring section.
- **Human-level monitoring** is the Discord channel plus a weekly glance at
  the Analytics tab.

## 10. CLI and API quick reference

All from `license-server/`, token read from the secrets file. Set once per
shell session:

```bash
URL=http://localhost:8420
TOKEN="$(cat ~/AI-Brain-build/asktoto-license/admin-token.txt)"
```

**Mint a license:**

```bash
node scripts/generate-license.mjs --url $URL --token "$TOKEN" \
  --company "Acme Corp" --seats 25 --expires 2027-01-01   # omit --expires = perpetual
```

**Back up / restore:** see chapter 7.

**Raw API** (full reference in the README):

```bash
curl -s $URL/admin/licenses -H "authorization: Bearer $TOKEN"          # list all
curl -s $URL/admin/stats -H "authorization: Bearer $TOKEN"             # business summary
curl -s $URL/admin/licenses/<KEY> -H "authorization: Bearer $TOKEN"    # one license, full detail
curl -s -X POST $URL/admin/licenses/<KEY>/revoke -H "authorization: Bearer $TOKEN"
curl -s -X PATCH $URL/admin/licenses/<KEY> -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"seatCap": 50}'
curl -s $URL/admin/licenses.csv -H "authorization: Bearer $TOKEN" -o licenses.csv
curl -s -X POST $URL/admin/backup -H "authorization: Bearer $TOKEN"    # snapshot now
```

## 11. Troubleshooting

**Is the server even up?**

```bash
docker ps --filter name=asktoto-license     # should say "Up ..."
curl http://localhost:8420/health           # should say ok:true
docker logs asktoto-license --tail 50       # recent activity + warnings
```

**Container not running:** `docker start asktoto-license`. If Docker Desktop
itself isn't running, start it first — the container auto-starts with it.

**Dashboard says "wrong admin token":** compare what you're pasting against
`admin-token.txt`. After 10 wrong attempts from one device, that device is
locked out for 15 minutes — wait it out (this is brute-force protection, not
a bug).

**App on a customer machine can't reach the server:** LAN-only for now (see
chapter 4's warning). Same network? `http://192.168.0.38:8420` — note
`http`, not `https`, until the public deploy.

**Server refuses to start, logs mention the licenses file:** deliberate —
the data file is unreadable and the server fails loud rather than starting
empty and un-licensing everyone. Restore the latest snapshot (chapter 7,
option C in MIGRATION.md for volume access) and start again.

**Something looks wrong with a license's history:** Audit log tab. Every
mutation is recorded with a timestamp — including which were done via
dashboard vs. the app freeing its own seat.

**Rotating the admin token** (leaked, or routine hygiene): write the new
value into `admin-token.txt`, recreate the container (chapter 2), then
re-connect the dashboard with the new token. CLI scripts pick it up
automatically since they read the file.

## 12. Security rules

- The **admin token** is the entire security model. Never send it in email
  or chat; it lives in `admin-token.txt` and in your password manager.
  Anyone with it can mint, revoke, and delete licenses.
- The **metrics token** is deliberately weaker (aggregate numbers only) —
  still don't publish it.
- The **Discord webhook URL** is a post-anything-to-your-channel credential.
  If the channel gets weird messages, regenerate the webhook in Discord and
  update the file + container.
- **License keys** are customer credentials. Send a key to its own customer
  only. Never post full keys in chat (the Discord alerts already truncate
  them).
- **Before going public** (customers outside the LAN): HTTPS via the
  `deploy/` bundle, and set `TRUST_PROXY=1` there (already configured in the
  bundle).

## 13. Moving the server

This Mac is a temporary home. The complete relocation recipe — what to
export, which secrets to carry, how to re-import and repoint customer apps —
is [`MIGRATION.md`](MIGRATION.md). Headline: only the data volume and four
small secret files matter; everything else rebuilds from the repo, and
customers ride out the move on the offline-grace window without noticing.

## 14. Operating rhythm — the checklists

**When something happens (Discord pings you):** chapter 8 has the move for
each alert. That's the whole day-to-day — the system is push, not poll.

**Weekly, two minutes:**
- [ ] Glance at the Analytics tab: activation chart looks like your business,
      "Last backup" is recent.
- [ ] Pull one off-box backup (chapter 7's one command).

**Before anything risky** (restore, migration, bulk edits):
- [ ] Analytics → **Back up now**.

**Monthly:**
- [ ] Skim the Audit log for anything you don't recognize.
- [ ] Check `docker logs asktoto-license --tail 100` for repeated warnings.

**Before the FIRST external customer** (one-time gate — don't skip):
- [ ] Deploy publicly with the [`deploy/`](deploy/README.md) bundle
      (domain + HTTPS + `TRUST_PROXY=1`).
- [ ] Migrate the data there per [`MIGRATION.md`](MIGRATION.md).
- [ ] Activate a test license from OUTSIDE your network before sending
      anything to a customer.
- [ ] Give customers the domain URL, never an IP — future moves then cost
      you a DNS change, not a support round-trip.
