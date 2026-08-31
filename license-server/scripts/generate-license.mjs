#!/usr/bin/env node
// CLI to mint a new license against a RUNNING license-server instance.
//
// Usage:
//   node scripts/generate-license.mjs --url <server-url> --token <admin-token> \
//     --company "Acme Corp" --seats 25 [--expires 2027-01-01]
//
//   node scripts/generate-license.mjs --url <server-url> --token <admin-token> \
//     --trial [--days 14] [--seats 1] [--company "Jane's trial"]

function parseArgs(argv) {
  const args = { expires: null, trial: false, days: null };
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
      case '--company':
        args.company = next();
        break;
      case '--seats':
        args.seats = next();
        break;
      case '--expires':
        args.expires = next();
        break;
      case '--trial':
        args.trial = true;
        break;
      case '--days':
        args.days = next();
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
  node scripts/generate-license.mjs --url <server-url> --token <admin-token> \\
    --company "Acme Corp" --seats 25 [--expires 2027-01-01]

Options:
  --url       Base URL of a running license-server (e.g. https://licenses.example.com)
  --token     Admin token (must match LICENSE_ADMIN_TOKEN on the server)
  --company   Company name for the license (required unless --trial)
  --seats     Seat cap, positive integer (required unless --trial, which defaults to 1)
  --expires   Optional expiry date, YYYY-MM-DD (omit for a perpetual license; ignored with --trial)
  --trial     Mint a time-boxed TRIAL key instead — no purchase, no price. Uses
              POST /admin/licenses/trial; --company/--seats become optional
  --days      Trial length in days (--trial only; server default is 14)
  --help      Show this message
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const missing = ['url', 'token', ...(args.trial ? [] : ['company', 'seats'])].filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`);
    printUsage();
    process.exit(1);
  }

  let seatCap;
  if (args.seats !== undefined && args.seats !== null) {
    seatCap = Number(args.seats);
    if (!Number.isInteger(seatCap) || seatCap <= 0) {
      console.error(`--seats must be a positive integer, got: ${args.seats}`);
      process.exit(1);
    }
  }

  let days;
  if (args.days !== null && args.days !== undefined) {
    days = Number(args.days);
    if (!Number.isInteger(days) || days <= 0) {
      console.error(`--days must be a positive integer, got: ${args.days}`);
      process.exit(1);
    }
  }

  let expiresAt = null;
  if (args.expires) {
    // End-of-day, matching the dashboard's date picker — "expires 2027-01-01" must mean the
    // customer keeps their full last day regardless of which tool minted the license.
    const parsedDate = new Date(`${args.expires}T23:59:59.999Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      console.error(`--expires must be a valid date (YYYY-MM-DD), got: ${args.expires}`);
      process.exit(1);
    }
    expiresAt = parsedDate.getTime();
  }

  const url = args.url.replace(/\/+$/, '');
  const endpoint = args.trial ? '/admin/licenses/trial' : '/admin/licenses';
  const body = args.trial
    ? { seats: seatCap, days, companyName: args.company }
    : { companyName: args.company, seatCap, expiresAt };

  const res = await fetch(`${url}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify(body),
  });

  const created = await res.json().catch(() => null);

  if (!res.ok) {
    console.error(`Request failed (HTTP ${res.status}):`, created || '(no response body)');
    process.exit(1);
  }

  console.log(args.trial ? '\nTrial license created successfully.\n' : '\nLicense created successfully.\n');
  console.log(`  Company:     ${created.companyName}`);
  console.log(`  Seat cap:    ${created.seatCap}`);
  console.log(`  Expires:     ${created.expiresAt ? new Date(created.expiresAt).toISOString() : 'never'}`);
  console.log('\n  License key:');
  console.log(`\n    ${created.licenseKey}\n`);
}

main().catch((err) => {
  console.error('Failed to generate license:', err);
  process.exit(1);
});
