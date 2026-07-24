// Durable, in-repo document store. Seed documents live as one JSON file per
// document under data/seed/. The loader validates each document and attaches
// provenance (source path, content checksum) so downstream context packs can
// carry citations. Zero external dependencies — only Node built-ins.

import { readFile, readdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_SEED_DIR = join(ROOT, 'data', 'seed');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VALID_TYPES = new Set([
  'concept', 'feature', 'experience', 'principle', 'note', 'policy'
]);

export function checksum(doc) {
  // Stable hash over the meaningful content fields (not provenance metadata).
  const canonical = JSON.stringify({
    id: doc.id,
    title: doc.title,
    type: doc.type,
    tags: doc.tags,
    body: doc.body,
    version: doc.version
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function fail(file, message) {
  throw new Error(`invalid seed document ${file}: ${message}`);
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

// Validate a raw parsed document and return a normalized, provenance-bearing copy.
export function normalizeDocument(raw, { file = '<inline>', dir = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(file, 'must be a JSON object');
  }
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    fail(file, 'id must be a lowercase slug (a-z, 0-9, hyphen)');
  }
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
    fail(file, 'title is required');
  }
  if (typeof raw.body !== 'string' || raw.body.trim().length === 0) {
    fail(file, 'body is required');
  }
  const type = raw.type || 'note';
  if (!VALID_TYPES.has(type)) {
    fail(file, `type "${type}" is not one of ${[...VALID_TYPES].join(', ')}`);
  }
  const tags = raw.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    fail(file, 'tags must be an array of strings');
  }
  const links = raw.links ?? [];
  if (!Array.isArray(links) || links.some((link) => typeof link !== 'string')) {
    fail(file, 'links must be an array of strings');
  }
  const version = raw.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    fail(file, 'version must be a positive integer');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (raw[field] !== undefined && !isIsoDate(raw[field])) {
      fail(file, `${field} must be a full ISO-8601 timestamp`);
    }
  }

  const doc = {
    id: raw.id,
    title: raw.title.trim(),
    type,
    tags,
    body: raw.body.trim(),
    links,
    version,
    author: typeof raw.author === 'string' ? raw.author : null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || raw.createdAt || null
  };
  doc.checksum = checksum(doc);
  doc.source = {
    kind: 'seed',
    path: dir ? relative(ROOT, join(dir, file)) : file,
    file
  };
  return doc;
}

function assembleRepository(rawFiles, dir) {
  const docs = [];
  const seen = new Map();
  for (const { file, contents } of rawFiles) {
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      fail(file, `not valid JSON (${error.message})`);
    }
    const doc = normalizeDocument(parsed, { file, dir });
    if (seen.has(doc.id)) {
      fail(file, `duplicate id "${doc.id}" (also in ${seen.get(doc.id)})`);
    }
    seen.set(doc.id, file);
    docs.push(doc);
  }
  // Deterministic order: most recently updated first, then by id.
  docs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
  return docs;
}

export async function loadDocuments(dir = DEFAULT_SEED_DIR) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const rawFiles = await Promise.all(
    names.map(async (file) => ({ file, contents: await readFile(join(dir, file), 'utf8') }))
  );
  return assembleRepository(rawFiles, dir);
}

export function loadDocumentsSync(dir = DEFAULT_SEED_DIR) {
  const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const rawFiles = names.map((file) => ({ file, contents: readFileSync(join(dir, file), 'utf8') }));
  return assembleRepository(rawFiles, dir);
}

// Backwards-compatible synchronous seed loader used by tests and tooling.
export function createSeedRepository() {
  return loadDocumentsSync();
}
