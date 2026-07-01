#!/usr/bin/env node
// Issue a BaseMouse API key directly against the database — how design
// partners get keys before self-serve entitlements (M2) exist, and the
// admin reissue / off-switch paths afterward. Runs via `kubectl exec` into
// the pod or a one-off Job, never from a workstation holding prod credentials
// (design decision 3A). Prints the plaintext key EXACTLY ONCE; only its
// SHA-256 hash is stored.
//
//   DATABASE_URL=... node scripts/issue-key.mjs --plan starter [--actor operator]
//   DATABASE_URL=... node scripts/issue-key.mjs --reissue --key-id <id>
//   DATABASE_URL=... node scripts/issue-key.mjs --revoke --key-id <id>
//   DATABASE_URL=... node scripts/issue-key.mjs --read-only --key-id <id>
//   DATABASE_URL=... node scripts/issue-key.mjs --reactivate --key-id <id>

import { parseArgs } from 'node:util';
import { PgStore } from '../src/pg-store.js';
import { generateKey, hashKey } from '../src/auth.js';

const { values } = parseArgs({
  options: {
    plan: { type: 'string', default: 'demo' },
    actor: { type: 'string', default: 'admin-script' },
    reissue: { type: 'boolean', default: false },
    revoke: { type: 'boolean', default: false },
    'read-only': { type: 'boolean', default: false },
    reactivate: { type: 'boolean', default: false },
    'key-id': { type: 'string' }
  }
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Off-switch operations are mutually exclusive with each other and with
// issuance; resolve which status (if any) was requested.
const statusFlags = [
  ['revoke', 'revoked'],
  ['read-only', 'read_only'],
  ['reactivate', 'active']
].filter(([flag]) => values[flag]);
if (statusFlags.length > 1) {
  console.error('--revoke, --read-only, and --reactivate are mutually exclusive');
  process.exit(1);
}
const statusOp = statusFlags[0]?.[1] || null;

const VALID_PLANS = new Set(['demo', 'starter', 'team', 'enterprise']);
if (!statusOp && !values.reissue && !VALID_PLANS.has(values.plan)) {
  console.error(`unknown plan "${values.plan}" (expected: ${[...VALID_PLANS].join(', ')})`);
  process.exit(1);
}

const store = new PgStore(databaseUrl, { max: 1 });
// Only issuance/reissue mint a new secret — status flips never do.
const plaintext = statusOp ? null : generateKey();

try {
  if (statusOp) {
    if (!values['key-id']) {
      console.error(`--${statusFlags[0][0]} requires --key-id <id>`);
      process.exit(1);
    }
    const updated = await store.setKeyStatus(values['key-id'], statusOp, values.actor);
    if (!updated) throw new Error(`no key with id ${values['key-id']}`);
    console.log(`set key ${updated.id} status -> ${updated.status}`);
  } else if (values.reissue) {
    if (!values['key-id']) {
      console.error('--reissue requires --key-id <id>');
      process.exit(1);
    }
    await store.tx(async (client) => {
      const updated = await client.query(
        "UPDATE keys SET key_hash = $2, rotated_at = now() WHERE id = $1 AND status <> 'system' RETURNING id, plan",
        [values['key-id'], hashKey(plaintext)]
      );
      if (updated.rowCount === 0) throw new Error(`no key with id ${values['key-id']}`);
      await client.query(
        'INSERT INTO key_audit (key_id, action, actor) VALUES ($1, $2, $3)',
        [values['key-id'], 'reissued', values.actor]
      );
    });
    console.log(`reissued key for workspace ${values['key-id']}`);
  } else {
    const key = await store.createKey({
      plan: values.plan,
      keyHash: hashKey(plaintext),
      actor: values.actor
    });
    console.log(`issued ${key.plan} key for new workspace ${key.id}`);
  }

  if (plaintext) {
    // The secret necessarily surfaces here once. Under `kubectl exec` this
    // also lands in terminal scrollback and may be captured by cluster audit
    // logging — so treat any echo as exposed: deliver over a one-time-view
    // channel (never paste raw into email/Slack), and --reissue (rotate) or
    // --revoke if the delivery path wasn't trusted.
    console.error('WARNING: the key below is a live secret. Deliver via a one-time-view');
    console.error('channel; do not paste it into email/Slack. Rotate (--reissue) or revoke');
    console.error('(--revoke) if the delivery path was not trusted.');
    console.log('\nAPI key (shown exactly once — store it now):\n');
    console.log(`  ${plaintext}\n`);
  }
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
