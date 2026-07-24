#!/usr/bin/env node
// Operator usage readout for one key across the FULL window — cumulative pack
// pulls (the /api/usage endpoint and getUsage are current-month only, so a
// 30-day window spanning a UTC month boundary undercounts) plus lifetime doc
// count. Built to check the design-partner validation criterion
// (>=50 real docs imported, >=100 context packs pulled). Runs via
// `kubectl exec` like issue-key.mjs (design decision 3A).
//
//   DATABASE_URL=... node scripts/usage-readout.mjs --key-id <id>

import { parseArgs } from 'node:util';
import { PgStore } from '../src/pg-store.js';

const { values } = parseArgs({ options: { 'key-id': { type: 'string' } } });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!values['key-id']) {
  console.error('--key-id <id> is required');
  process.exit(1);
}

const store = new PgStore(databaseUrl, { max: 1 });

try {
  const u = await store.getCumulativeUsage(values['key-id']);
  if (!u) {
    console.error(`no key with id ${values['key-id']}`);
    process.exitCode = 1;
  } else {
    console.log(`key ${u.keyId}  plan=${u.plan}  status=${u.status}`);
    console.log(`documents: ${u.docCount}   storage: ${u.storageBytes} bytes`);
    console.log(`pack pulls (cumulative, all months): ${u.totalPackPulls}`);
    for (const m of u.months) console.log(`  ${m.month}: ${m.packPulls}`);
    // Validation criterion (docs/designs/real-service-core.md:21-28).
    const docsOk = u.docCount >= 50;
    const pullsOk = u.totalPackPulls >= 100;
    console.log(`\nvalidation: docs ${u.docCount}/50 ${docsOk ? 'OK' : '—'}   pulls ${u.totalPackPulls}/100 ${pullsOk ? 'OK' : '—'}`);
  }
} catch (error) {
  console.error(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
