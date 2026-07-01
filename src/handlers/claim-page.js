// The claim page (design decision 11A): the single highest-stakes screen in
// the product — someone just paid and either gets their key or a reason to
// dispute the charge. Five designed states, all server-rendered (the claim
// runs server-side on GET, so the page works without JavaScript; the copy
// button in /claim.js is progressive enhancement — CSP forbids inline JS).
//
//   verifying      → the request itself (server-side, no visible state)
//   key-shown      → plaintext ONCE + "save it now" warning
//   stripe-down    → "payment safe, retry" + retry link
//   already-claimed→ refresh case; calm copy, NEVER reads as lost money
//   missing-session→ explanation + pricing link

// Terminal Industrial styling per DESIGN.md (decision 2A: the claim page —
// the trust handshake — ships in the same visual system as the site).
function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#0b0b09">
  <title>${title} — BaseMouse</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,800;62..125,900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#0b0b09; --panel:#121310; --line:#262722; --line-hot:#3a3b33;
            --fg:#e8e6df; --dim:#8b897f; --amber:#ffb000; --amber-ink:#1a1404; --ok:#9acd32; }
    * { box-sizing: border-box; margin: 0; }
    body { background: var(--bg); color: var(--fg);
           font-family: "JetBrains Mono", monospace; font-size: 16px; line-height: 1.65; }
    .claim-wrap { max-width: 640px; margin: 8vh auto; padding: 0 1.25rem; }
    .claim-brand { font-family: "Archivo", sans-serif; font-weight: 900; font-stretch: 125%;
                   font-size: 18px; margin-bottom: 18px; letter-spacing: .02em;
                   display: inline-flex; align-items: center; gap: 10px; }
    .claim-brand b { color: var(--amber); }
    .claim-brand svg { display: block; }
    .claim-card { background: var(--panel); border: 1px solid var(--line-hot);
                  box-shadow: 0 0 0 1px #000, 0 24px 60px rgba(0,0,0,.5); padding: 2rem; }
    .claim-card h1 { font-family: "Archivo", sans-serif; font-weight: 800; font-stretch: 110%;
                     font-size: 26px; line-height: 1.1; margin-bottom: 14px; }
    .claim-card p { color: var(--dim); margin: 10px 0; }
    .claim-card a { color: var(--amber); text-decoration: none; }
    .claim-card a:hover { text-decoration: underline; }
    .claim-card code, .claim-card pre { color: var(--ok); }
    .claim-card pre { background: var(--bg); border: 1px solid var(--line);
                      padding: 12px 14px; font-size: 12.5px; white-space: pre-wrap;
                      word-break: break-word; margin: 12px 0; }
    .claim-key { font-size: 15px; word-break: break-all; padding: .9rem 1rem;
                 border: 1px dashed var(--amber); color: var(--fg);
                 margin: 1rem 0; user-select: all; background: var(--bg); }
    .claim-warning { color: var(--amber); font-weight: 700; }
    .claim-actions { margin-top: 1.25rem; display: flex; gap: .75rem; flex-wrap: wrap; }
    .claim-actions button { background: var(--amber); color: var(--amber-ink);
                            border: 1px solid var(--amber); font: inherit; font-weight: 700;
                            text-transform: uppercase; letter-spacing: .08em; font-size: 13px;
                            padding: 13px 22px; cursor: pointer; min-height: 44px; }
    .claim-actions button:hover { background: #ffc234; }
    :focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  </style>
</head>
<body>
  <main class="claim-wrap">
    <div class="claim-brand"><svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="10" fill="#121310"/><rect x="3" y="3" width="58" height="58" rx="9" fill="none" stroke="#3a3b33"/><path d="M16 39C3 30 6 11 27 8" fill="none" stroke="#ffb000" stroke-width="6" stroke-linecap="round"/><path d="M17 54V35c0-14 13-24 27-18" fill="none" stroke="#ffb000" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 18c6 3 11 7 17 16l-10 8" fill="none" stroke="#ffb000" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="42" cy="20" r="8" fill="#0b0b09" stroke="#ffb000" stroke-width="6"/><circle cx="49" cy="31" r="3.2" fill="#9acd32"/></svg><span>BASE<b>MOUSE</b></span></div>
    <div class="claim-card">${bodyHtml}</div>
  </main>
  <script src="/claim.js" defer></script>
</body>
</html>`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderKeyShown({ key, workspace, plan }) {
  return page('Your API key', `
    <h1>You're in. Here is your API key.</h1>
    <p class="claim-warning">Save it now — it is shown exactly once and cannot be retrieved.</p>
    <div class="claim-key" id="claim-key">${esc(key)}</div>
    <div class="claim-actions">
      <button id="copy-key" type="button">Copy key</button>
    </div>
    <p>Workspace <code>${esc(workspace)}</code> · plan <strong>${esc(plan)}</strong></p>
    <p>First step: import your docs —</p>
    <pre><code>BASEMOUSE_API_KEY=&lt;your key&gt; node scripts/import.mjs ./docs --base-url https://basemouse.com</code></pre>
    <p><a href="/docs/agent-integration.md">Agent integration guide</a></p>
  `);
}

export function renderStripeDown(sessionId) {
  return page('Almost there', `
    <h1>Your payment is safe.</h1>
    <p>We couldn't finish issuing your key because our payment provider didn't answer.
       Nothing is lost — retry in a minute and your key will be issued.</p>
    <div class="claim-actions">
      <a href="/claim?session_id=${encodeURIComponent(sessionId)}"><button type="button">Retry now</button></a>
    </div>
  `);
}

export function renderAlreadyClaimed() {
  return page('Key already issued', `
    <h1>Your key was already issued for this purchase.</h1>
    <p>Keys are shown exactly once, so refreshing this page can't display it again —
       this is a safety feature, not an error. Your payment and workspace are fine.</p>
    <p>If you didn't save the key, contact
       <a href="mailto:devsupport@basemouse.com?subject=BaseMouse%20key%20reissue">support</a>
       and we'll reissue it after verifying the purchase.</p>
  `);
}

export function renderMissingSession() {
  return page('Missing checkout session', `
    <h1>This page needs a checkout session.</h1>
    <p>You usually arrive here automatically after paying. If you landed here by hand,
       head to <a href="/#pricing">pricing</a> — or contact
       <a href="mailto:devsupport@basemouse.com?subject=BaseMouse">support</a> if you paid
       and ended up somewhere unexpected.</p>
  `);
}

export function renderInvalidSession() {
  return page('Unknown checkout session', `
    <h1>We don't recognize this checkout session.</h1>
    <p>It may be unpaid, expired, or mistyped. If you completed a payment, contact
       <a href="mailto:devsupport@basemouse.com?subject=BaseMouse%20claim%20problem">support</a>
       with your receipt and we'll sort it out.</p>
    <p><a href="/#pricing">Back to pricing</a></p>
  `);
}
