# Host it yourself

This guide gets the AskToto license server running on a server you own, with
a real HTTPS address that customer machines anywhere on the internet can
reach - not just your own network. No coding required.

## What you need

- A server with a public IP address. Any of these work:
  - A cheap VPS: a $5/month box from Hetzner, DigitalOcean, or Vultr is
    plenty (any similar provider works too).
  - A home server or spare PC, as long as you can forward ports on your
    router (see step 3).
  - A Raspberry Pi 4 or 5 works fine too.
- A domain name you control (e.g. `yourcompany.com`), so you can point a
  subdomain like `licenses.yourcompany.com` at the server.
- Docker installed on the server. If it isn't yet, `run.sh` (step 5 below)
  will tell you how.

## Steps

### a. Point a DNS A record at your server

In your domain's DNS settings, add an **A record** for the subdomain you want
to use, e.g. `licenses` on `yourcompany.com`, pointing at your server's
public IP address. This makes `licenses.yourcompany.com` resolve to your
server.

DNS changes can take a few minutes to a couple of hours to take effect.

### b. Open ports 80 and 443

Make sure ports 80 and 443 are reachable from the internet on your server.

- On most VPS providers, this is open by default (check the provider's
  firewall/security-group settings if not).
- On a home server, you'll need to forward ports 80 and 443 to it in your
  router's settings.

Both ports are needed even though customers only ever talk to port 443 -
Caddy (the piece that gets you HTTPS automatically) uses port 80 briefly to
prove to Let's Encrypt that you control the domain.

### c. Copy the example config and fill it in

On the server, inside this `deploy/` folder:

```bash
cp .env.example .env
```

Open `.env` in any text editor and set:

- `LICENSE_DOMAIN` - the domain from step (a), e.g. `licenses.yourcompany.com`
- `LICENSE_ADMIN_TOKEN` - a long random secret. Generate one with:

  ```bash
  openssl rand -hex 24
  ```

  Save this token somewhere safe (like a password manager) - it's what lets
  you log into the dashboard and manage licenses. Anyone with this token can
  create, revoke, or edit licenses.

### d. Run it

From this `deploy/` folder:

```bash
./run.sh
```

This checks that Docker is installed, builds the license server, and starts
it alongside Caddy, which fetches a free HTTPS certificate for your domain
automatically. The first run can take a minute or two while the certificate
is issued - that's normal.

### e. Open the dashboard

Once `run.sh` finishes, open:

```
https://licenses.yourcompany.com/admin/ui
```

(using your own domain instead). Paste in the `LICENSE_ADMIN_TOKEN` from step
(c) when prompted, and you're ready to start creating license keys.

### f. Point AskToto at your server

In the AskToto app, go to **Settings -> About -> License** and enter your
server's URL, e.g. `https://licenses.yourcompany.com`. Once that's set,
customer machines anywhere on the internet can activate against your
license server.

## No domain yet?

If you just want to try this out on your own network first, skip Caddy
entirely and run the plain compose file from the parent directory instead:

```bash
cd ..
LICENSE_ADMIN_TOKEN=$(openssl rand -hex 24) docker compose up -d --build
```

This serves plain HTTP at `http://<server-ip>:8420`, reachable on your LAN.
It's fine for testing, but real customers need the HTTPS domain path above -
browsers and the AskToto app both expect `https://` for anything reachable
over the public internet.

## Backups

Your license data lives in a Docker volume, not a plain file on disk, so back
it up over the network rather than copying a file by hand. Use the bundled
script:

```bash
node ../scripts/backup.mjs --url https://licenses.yourcompany.com --token "$LICENSE_ADMIN_TOKEN"
```

See the "Backups" section in the main `README.md` for the full crontab
example to run this automatically every day.
