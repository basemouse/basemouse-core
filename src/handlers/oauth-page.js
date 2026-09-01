// Consent page for MCP OAuth: paste an existing bm_ key, or continue with
// the public demo. Server-rendered, no JavaScript (CSP script-src self).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hidden(params) {
  const fields = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource'];
  return fields
    .filter((name) => params[name])
    .map((name) => `<input type="hidden" name="${esc(name)}" value="${esc(params[name])}">`)
    .join('\n');
}

export function renderConsent({ params, error = '' }) {
  const err = error
    ? `<p class="oauth-error">${esc(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#0b0b09">
  <title>Connect BaseMouse</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,800;62..125,900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#0b0b09; --panel:#121310; --line:#262722; --line-hot:#3a3b33;
            --fg:#e8e6df; --dim:#8b897f; --amber:#ffb000; --amber-ink:#1a1404; --bad:#ff6b4a; }
    * { box-sizing: border-box; margin: 0; }
    body { background: var(--bg); color: var(--fg);
           font-family: "JetBrains Mono", monospace; font-size: 16px; line-height: 1.65; }
    .wrap { max-width: 640px; margin: 8vh auto; padding: 0 1.25rem; }
    .brand { font-family: "Archivo", sans-serif; font-weight: 900; font-stretch: 125%;
             font-size: 18px; margin-bottom: 18px; letter-spacing: .02em; }
    .brand b { color: var(--amber); }
    .card { background: var(--panel); border: 1px solid var(--line-hot);
            box-shadow: 0 0 0 1px #000, 0 24px 60px rgba(0,0,0,.5); padding: 2rem; }
    h1 { font-family: "Archivo", sans-serif; font-weight: 800; font-stretch: 110%;
         font-size: 26px; line-height: 1.1; margin-bottom: 14px; }
    p { color: var(--dim); margin: 10px 0; }
    label { display: block; color: var(--fg); font-size: 13px; letter-spacing: .06em;
            text-transform: uppercase; margin: 1.25rem 0 .4rem; }
    input[type=password] { width: 100%; background: var(--bg); color: var(--fg);
            border: 1px solid var(--line-hot); font: inherit; padding: 12px 14px; }
    .actions { margin-top: 1.25rem; display: flex; gap: .75rem; flex-wrap: wrap; }
    button { background: var(--amber); color: var(--amber-ink); border: 1px solid var(--amber);
             font: inherit; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
             font-size: 13px; padding: 13px 22px; cursor: pointer; min-height: 44px; }
    button.secondary { background: transparent; color: var(--fg); border-color: var(--line-hot); }
    .oauth-error { color: var(--bad); font-weight: 700; }
    :focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="brand">BASE<b>MOUSE</b></div>
    <div class="card">
      <h1>Connect Cursor to BaseMouse</h1>
      <p>Paste the API key from your BaseMouse workspace. Cursor will use it as the access token for this MCP connection.</p>
      ${err}
      <form method="post" action="/oauth/authorize">
        ${hidden(params)}
        <label for="api_key">API key</label>
        <input id="api_key" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="bm_...">
        <div class="actions">
          <button type="submit" name="intent" value="key">Authorize</button>
          <button type="submit" name="intent" value="demo" class="secondary">Continue with public demo</button>
        </div>
      </form>
      <p>The public demo is the shared corpus on basemouse.com. Writes still need a paid key.</p>
    </div>
  </main>
</body>
</html>`;
}

export function renderAuthorizeError(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorization error</title>
<meta name="robots" content="noindex">
<style>body{font-family:monospace;background:#0b0b09;color:#e8e6df;padding:2rem}</style>
</head><body><h1>Authorization error</h1><p>${esc(message)}</p></body></html>`;
}
