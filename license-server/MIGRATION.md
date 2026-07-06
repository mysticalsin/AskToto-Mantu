# Moving the license server to another machine

This server is currently hosted temporarily on a workstation via Docker. This
file is the complete recipe for taking everything with you when it moves to
its permanent home (a VPS, a Raspberry Pi, Fly.io — anywhere Docker or Node
runs). Total downtime: a few minutes, and the apps tolerate it anyway (they
have a 7-day offline grace window, so nothing gets locked out while you move).

## What actually needs to move

Only two things are irreplaceable:

1. **The license data** — one JSON file (`licenses.json`) plus the audit trail
   (`audit.jsonl`). On a Docker host they live inside the volume
   (`asktoto-license-data`, mounted at `/app/data`). Everything else
   (the code, the container image) is rebuilt from this git repo.
2. **The secrets** — the env values the server runs with:
   - `LICENSE_ADMIN_TOKEN` (the admin credential — the important one)
   - `METRICS_TOKEN` (if metrics are enabled)
   - `LICENSE_WEBHOOK_URL` / `LICENSE_WEBHOOK_SECRET` (if webhooks are enabled)

   On the current host these are saved in `~/AI-Brain-build/asktoto-license/`
   (`admin-token.txt`, `metrics-token.txt`, `discord-webhook.txt`). Copy that
   folder's contents to a password manager before the machine goes away.

## Step 1 — Export the data (pick any one)

**A. Admin API from any machine (recommended — no access to the old box needed):**

```bash
cd license-server
node scripts/backup.mjs --url http://<old-host>:8420 --token <ADMIN_TOKEN> --out ./migration
# -> ./migration/licenses-backup-<timestamp>.json
```

**B. Dashboard:** open `http://<old-host>:8420/admin/ui` → Analytics tab →
the server keeps its own snapshots; download the newest one via
`GET /admin/backups` + `GET /admin/backups/<name>` (or just use option A).

**C. Raw volume copy (old box shell access, belt-and-braces):**

```bash
docker run --rm -v asktoto-license-data:/data -v "$PWD":/out alpine \
  tar czf /out/asktoto-license-data.tgz -C /data .
```

Option A/B files are restore-compatible with the API; option C is a raw copy
of the whole data dir (licenses + audit log + on-server snapshots).

## Step 2 — Stand the server up on the new host

**Same-LAN / quick (plain Docker, HTTP):**

```bash
git clone <this repo> && cd AskToto/license-server
LICENSE_ADMIN_TOKEN=<same-or-new-token> docker compose up -d --build
```

**Public internet with a domain + auto-HTTPS (the real setup):** use the
turnkey bundle in [`deploy/`](deploy/README.md) — copy `deploy/.env.example`
to `deploy/.env`, fill in `LICENSE_DOMAIN`, the admin token, and the optional
webhook/metrics values from Step 0's secrets, then `./run.sh`. Caddy fetches
the Let's Encrypt certificate automatically.

## Step 3 — Import the data

**From an option A/B backup file (server can be running):**

```bash
node scripts/restore.mjs --url https://<new-host> --token <ADMIN_TOKEN> \
  --file ./migration/licenses-backup-<timestamp>.json --yes
```

The new server snapshots its (empty) store first, validates the payload, and
replaces everything atomically. Verify: `GET /health` shows the right
`licenseCount`, dashboard shows the licenses.

**From an option C tarball (before first start):**

```bash
docker volume create asktoto-license-data
docker run --rm -v asktoto-license-data:/data -v "$PWD":/in alpine \
  tar xzf /in/asktoto-license-data.tgz -C /data
```

## Step 4 — Repoint the apps

Each customer machine stores the server URL next to its license key
(AskToto → Settings → About → License). If the URL changes (new domain/IP),
that field needs the new value once per machine — activations themselves are
already in the migrated data, so the same key + machine revalidates without
consuming a new seat. To avoid ever doing this again, put a domain name
(not a raw IP) in front of the server before rolling it out to customers —
then future moves are a DNS change and nobody touches an app setting.

## Step 5 — Confirm, then retire the old box

- `GET /health` on the new host: correct `licenseCount`.
- Dashboard Analytics tab: "Last backup" populates within a minute of boot
  (the startup snapshot) — automatic backups are live on the new host.
- If webhooks are configured: create + delete a throwaway test license and
  watch the two messages arrive.
- Then `docker rm -f asktoto-license` on the old machine. Keep the Step 1
  backup file somewhere safe off both machines.
