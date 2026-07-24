#!/usr/bin/env node
// Apply migrations/*.sql in order against DATABASE_URL. Migrations are
// idempotent SQL (IF NOT EXISTS everywhere), so the runner applies the whole
// directory every time — no tracking table to drift from Supabase's own
// migration history. Runs in CI (deploy.yml migrate job) before kubectl
// deploy, and against a throwaway rehearsal database first.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgStore } from '../src/pg-store.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Announce the sanitized target so CI logs show exactly what we're dialing —
// host, port, database, user — without ever printing the password.
try {
  const parsed = new URL(databaseUrl);
  console.log(
    `target: host=${parsed.hostname} port=${parsed.port || '5432'} ` +
    `db=${parsed.pathname.replace(/^\//, '') || '(none)'} user=${parsed.username || '(none)'} ` +
    `ca_cert=${process.env.DATABASE_CA_CERT ? 'provided' : 'system trust store'}`
  );
} catch {
  console.error('DATABASE_URL is set but is not a parseable URL — check for stray quotes/whitespace in the secret');
  process.exit(1);
}

const store = new PgStore(databaseUrl, { max: 1 });
const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

try {
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`applying ${file}... `);
    await store.query(sql);
    console.log('ok');
  }
  console.log(`migrations complete (${files.length} file${files.length === 1 ? '' : 's'})`);
} catch (error) {
  const cause = error.cause || error;
  console.error(`\nmigration failed: ${error.message}`);
  if (cause.code) console.error(`error code: ${cause.code}`);
  // Map the common failure classes to their fixes right in the CI log.
  if (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN') {
    console.error('→ DNS/IPv4 problem: use the Session Pooler URL (Dashboard → Connect), not the direct db.*.supabase.co host');
  } else if (cause.code === 'SELF_SIGNED_CERT_IN_CHAIN' || cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /certificate/i.test(cause.message || '')) {
    console.error('→ TLS chain problem: set the DATABASE_CA_CERT secret to the provider CA PEM (Supabase Dashboard → Database → SSL)');
  } else if (/password authentication failed/i.test(cause.message || '')) {
    console.error('→ Auth problem: wrong password, or pooler URLs need username postgres.<project-ref> (not plain postgres)');
  } else if (cause.code === 'ETIMEDOUT' || cause.code === 'ECONNREFUSED') {
    console.error('→ Network problem: host unreachable from this runner; check pooler URL/port and project status (paused?)');
  }
  process.exitCode = 1;
} finally {
  await store.close();
}
