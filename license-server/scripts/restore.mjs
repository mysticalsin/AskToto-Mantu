#!/usr/bin/env node
// CLI to RESTORE all license data into a running license-server from a backup file made by
// scripts/backup.mjs. The server snapshots its current data to a timestamped .bak next to its db
// BEFORE replacing, so a wrong restore can't destroy the existing licenses.
//
// Usage:
//   node scripts/restore.mjs --url <server-url> --token <admin-token> --file ./backups/licenses-backup-....json
//
// This REPLACES the entire store with the file's licenses. To be safe, take a fresh backup first.

import { readFile } from 'node:fs/promises';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--url': args.url = next(); break;
      case '--token': args.token = next(); break;
      case '--file': args.file = next(); break;
      case '--yes': args.yes = true; break;
      case '--help':
      case '-h': args.help = true; break;
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
  node scripts/restore.mjs --url <server-url> --token <admin-token> --file <backup.json> [--yes]

Options:
  --url     Base URL of a running license-server (e.g. https://licenses.example.com)
  --token   Admin token (must match LICENSE_ADMIN_TOKEN on the server)
  --file    A backup file written by scripts/backup.mjs (or a raw array of licenses)
  --yes     Skip the confirmation prompt (for scripted/automated restores)
  --help    Show this message

WARNING: this REPLACES the entire license store on the server with the file's contents.
The server writes a pre-restore snapshot (.bak) next to its data file first.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  const missing = ['url', 'token', 'file'].filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`);
    printUsage();
    process.exit(1);
  }

  const url = args.url.replace(/\/+$/, '');
  const raw = await readFile(args.file, 'utf8');
  const parsed = JSON.parse(raw);
  // Accept a backup wrapper ({ licenses: [...] }) or a raw array.
  const licenses = Array.isArray(parsed) ? parsed : parsed.licenses;
  if (!Array.isArray(licenses)) {
    console.error('Backup file must be a { "licenses": [...] } object or a raw array.');
    process.exit(1);
  }

  if (!args.yes) {
    console.log(`About to REPLACE the entire store at ${url} with ${licenses.length} license(s) from ${args.file}.`);
    console.log('The server will snapshot its current data first. Re-run with --yes to proceed.');
    process.exit(0);
  }

  const res = await fetch(`${url}/admin/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.token}` },
    body: JSON.stringify({ licenses }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok !== true) {
    console.error(`Restore failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`Restored ${body.restoredCount} license(s). Pre-restore snapshot on the server: ${body.snapshot || '(none written)'}`);
}

main().catch((err) => {
  console.error('Restore failed:', err.message || err);
  process.exit(1);
});
