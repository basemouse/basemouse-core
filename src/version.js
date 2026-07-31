import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Single source of truth for the running build's version. Every surface that
// reports a version (healthz, MCP serverInfo) reads it from package.json rather
// than carrying its own copy — hardcoded duplicates silently drift, which is how
// /healthz shipped the 0.3.0 release still reporting 0.2.0.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
