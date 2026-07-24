# BaseMouse Client Libraries

BaseMouse ships dependency-light client helpers for agents and local integrations.

## JavaScript / TypeScript

Files:

- `clients/js/basemouse-client.js`
- `clients/js/basemouse-client.d.ts`

```js
import { BaseMouseClient, formatContextPackForPrompt } from './clients/js/basemouse-client.js';

const bm = new BaseMouseClient({
  baseUrl: process.env.BASEMOUSE_URL || 'https://basemouse.com',
  apiKey: process.env.BASEMOUSE_API_KEY
});

const pack = await bm.contextPack({ q: 'release policy', limit: 5 });
console.log(formatContextPackForPrompt(pack));
```

Supported methods: `search`, `contextPack`, `listRepository`, `createDocument`, `updateDocument`, `deleteDocument`, `documentHistory`, `usage`, and `rotateKey`.

## Python

File: `clients/python/basemouse_client.py` (stdlib only).

```python
from clients.python.basemouse_client import BaseMouseClient, format_context_pack_for_prompt

bm = BaseMouseClient(base_url='https://basemouse.com', api_key='bm_...')
pack = bm.context_pack('release policy', limit=5)
print(format_context_pack_for_prompt(pack))
```

## Environment defaults

Both clients read:

```text
BASEMOUSE_URL=https://basemouse.com
BASEMOUSE_API_KEY=bm_...
# BASEMOUSE_TOKEN is accepted as an alias
```

## Testing without network

```bash
node --test test/client-libraries.test.js
python3 -m unittest clients/python/test_basemouse_client.py
```

## See also

Not writing code against the API? The workspace sync CLI
(`integrations/cli/basemouse.mjs` — `sync`/`watch`/`register`/`snippet`) and the
GitHub Action (`integrations/github-action/`) cover the "keep my docs in
BaseMouse" case without any client code, and `docs/agent-integration.md` covers
consuming context packs from agents (REST or MCP).
