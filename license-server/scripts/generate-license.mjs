#!/usr/bin/env node
// CLI to mint a new license against a RUNNING license-server instance.
//
// Usage:
//   node scripts/generate-license.mjs --url <server-url> --token <admin-token> \
//     --company "Acme Corp" --seats 25 [--expires 2027-01-01]

function parseArgs(argv) {
  const args = { expires: null };
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
  --company   Company name for the license
  --seats     Seat cap (positive integer)
  --expires   Optional expiry date, YYYY-MM-DD (omit for a perpetual license)
  --help      Show this message
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const missing = ['url', 'token', 'company', 'seats'].filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`);
    printUsage();
    process.exit(1);
  }

  const seatCap = Number(args.seats);
  if (!Number.isInteger(seatCap) || seatCap <= 0) {
    console.error(`--seats must be a positive integer, got: ${args.seats}`);
    process.exit(1);
  }

  let expiresAt = null;
  if (args.expires) {
    const parsedDate = new Date(`${args.expires}T00:00:00Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      console.error(`--expires must be a valid date (YYYY-MM-DD), got: ${args.expires}`);
      process.exit(1);
    }
    expiresAt = parsedDate.getTime();
  }

  const url = args.url.replace(/\/+$/, '');
  const res = await fetch(`${url}/admin/licenses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      companyName: args.company,
      seatCap,
      expiresAt,
    }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    console.error(`Request failed (HTTP ${res.status}):`, body || '(no response body)');
    process.exit(1);
  }

  console.log('\nLicense created successfully.\n');
  console.log(`  Company:     ${body.companyName}`);
  console.log(`  Seat cap:    ${body.seatCap}`);
  console.log(`  Expires:     ${body.expiresAt ? new Date(body.expiresAt).toISOString() : 'never'}`);
  console.log('\n  License key:');
  console.log(`\n    ${body.licenseKey}\n`);
}

main().catch((err) => {
  console.error('Failed to generate license:', err);
  process.exit(1);
});
