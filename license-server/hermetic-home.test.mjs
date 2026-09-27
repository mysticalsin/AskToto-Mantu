import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// W0-HERMETIC (M2-0190) — license-server's own `npm test` is plain `node --test`, which has no
// config-level env hook the way vitest.config.ts's `test.env` gives every vitest worker (M2-0001).
// `package.json`'s "test" script runs through scripts/hermetic/run-with-sandbox.mjs, so every test file
// here — this one included — starts under a fresh, empty HOME/TMPDIR. This canary is the tripwire: if
// that wrapper is ever removed or bypassed, it fails loudly instead of the suite silently going back
// to reading/writing the real developer profile.
describe('hermetic home — license-server tests run against a per-run sandbox, not the real profile', () => {
  it('homedir() and tmpdir() are the sandbox run-with-sandbox.mjs created', () => {
    assert.ok(process.env.METIS_TEST_HOME, 'METIS_TEST_HOME must be set by scripts/hermetic/run-with-sandbox.mjs');
    const home = homedir();
    assert.equal(home, process.env.METIS_TEST_HOME);
    assert.match(basename(home), /^metis-test-home-/);
    assert.equal(tmpdir(), join(home, 'tmp'));
  });
  // Isolation itself is proven by isolation-canary.yml's license-server job, which seeds a honeypot in
  // the runner's real home and fails the job if this suite ever touches it — a check against the fresh
  // mkdtemp'd sandbox dir here would pass trivially (empty by construction) and prove nothing.
});
