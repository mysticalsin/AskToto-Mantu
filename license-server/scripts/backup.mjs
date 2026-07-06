#!/usr/bin/env node
// CLI to back up all license data from a RUNNING license-server instance,
// via its admin API (no direct file/volume access needed).
//
// Usage:
//   node scripts/backup.mjs --url <server-url> --token <admin-token> [--out ./backups]

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { out: './backups' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--url':
        args.url = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage:
  node scripts/backup.mjs --url <server-url> --token <admin-token> [--out ./backups]

Options:
  --url       Base URL of a running license-server (e.g. https://licenses.example.com)
  --token     Admin token (must match LICENSE_ADMIN_TOKEN on the server)
  --out       Directory to write the backup file into (default: ./backups)
  --help      Show this message
`);
}

async function fetchAdminJson(url, token, pathname) {
  const res = await fetch(`${url}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Request to ${pathname} failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const missing = ['url', 'token'].filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`);
    printUsage();
    process.exit(1);
  }

  const url = args.url.replace(/\/+$/, '');

  // The list endpoint omits activations/contactEmail/notes, so fetch each
  // license's full detail too — a backup is only useful if it's complete.
  const list = await fetchAdminJson(url, args.token, '/admin/licenses');
  const licenses = [];
  for (const entry of list) {
    const detail = await fetchAdminJson(url, args.token, `/admin/licenses/${encodeURIComponent(entry.licenseKey)}`);
    licenses.push(detail);
  }

  const backup = {
    generatedAt: new Date().toISOString(),
    server: url,
    licenseCount: licenses.length,
    licenses,
  };

  await mkdir(args.out, { recursive: true });
  const stamp = backup.generatedAt.replace(/[:.]/g, '-');
  const outPath = path.join(args.out, `licenses-backup-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(backup, null, 2), 'utf8');

  console.log(`Backed up ${licenses.length} license(s) to ${outPath}`);
}

main().catch((err) => {
  console.error('Backup failed:', err.message || err);
  process.exit(1);
});
