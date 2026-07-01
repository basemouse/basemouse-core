import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const compose = readFileSync('deployment/compose/docker-compose.yml', 'utf8');
for (const needle of ['basemouse:', 'slack-bot:', 'ollama:', 'profiles: ["slack"]', 'BASEMOUSE_URL: http://basemouse:3000']) {
  assert.ok(compose.includes(needle), `compose file missing ${needle}`);
}

// Self-hosted image flow: a fresh checkout must pull a real published image by
// default, while keeping a build stanza so `--build` still works for local dev.
assert.ok(
  compose.includes('ghcr.io/basemouse/basemouse:latest'),
  'compose must default the basemouse image to ghcr.io/basemouse/basemouse:latest'
);
assert.ok(
  compose.includes('${BASEMOUSE_IMAGE:-ghcr.io/basemouse/basemouse:latest}'),
  'compose basemouse image must be overridable via ${BASEMOUSE_IMAGE} for local builds'
);
assert.ok(
  /build:\s*\n\s*context:/.test(compose),
  'compose must keep a build stanza so local `docker compose up --build` still works'
);
assert.ok(
  !compose.includes('basemouse-demo'),
  'compose must not reference the stale basemouse-demo repo/image'
);

const env = readFileSync('deployment/compose/.env.example', 'utf8');
for (const key of [
  // The image override must be documented for operators choosing pull vs build.
  'BASEMOUSE_IMAGE',
  'BASEMOUSE_PORT', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'LLM_BASE_URL', 'BASEMOUSE_TOKEN',
  // Self-hosted licensing + governance hooks must stay documented for operators.
  'BASEMOUSE_LICENSE_TIER', 'BASEMOUSE_SELF_HOSTED', 'MESHAI_OTLP_ENDPOINT'
]) {
  assert.ok(env.includes(key), `.env.example missing ${key}`);
}
assert.ok(
  env.includes('ghcr.io/basemouse/basemouse:latest'),
  '.env.example must document the default GHCR image for BASEMOUSE_IMAGE'
);
console.log('compose static validation passed');
