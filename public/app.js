// BaseMouse live hero terminal (design: docs/designs/website-redesign.md, 1A).
// The hero session is the interactive demo: queries hit /api/search and
// /api/context-pack and render as terminal output. All content flows through
// textContent — no innerHTML, no sanitizer dependency, no XSS surface.

const termLog = document.querySelector('#term-log');
const termForm = document.querySelector('#term-form');
const termInput = document.querySelector('#term-input');
const liveStatusEl = document.querySelector('#live-status');
const copyCurlEl = document.querySelector('#copy-curl');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let lastPack = null;
let busy = false;

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const [key, value] of Object.entries(opts.attrs || {})) node.setAttribute(key, value);
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

// Append a line to the terminal and keep it scrolled to the newest output.
function line(parts, cls) {
  const row = el('div', cls ? { class: cls } : {});
  for (const part of Array.isArray(parts) ? parts : [parts]) {
    if (typeof part === 'string') row.append(document.createTextNode(part));
    else if (part) row.append(part);
  }
  termLog.append(row);
  termLog.scrollTop = termLog.scrollHeight;
  return row;
}

const span = (text, cls) => el('span', { class: cls, text });

// ---------- self-typing intro (motion 1 — once per session, reduced-motion-safe)

const INTRO = [
  ['$ ', 'p', 'basemouse import ./docs', 'o'],
  ['imported  47 documents → workspace ws-x91 (47 revisions, 47 checksums)', 'c'],
  ['$ ', 'p', 'curl "basemouse.com/api/context-pack?q=deploy+rollback"', 'o'],
  ['{ "schema": "context_pack.v1", "entries": 3, "citations": 3,', 'k'],
  ['  "provenance": { "checksum": "e765f4dc…", "version": 3 } }', 'k'],
  ['# every claim → a source. every source → a version.', 'c'],
  ['# this prompt is live — try a query below, or tap a suggestion.', 'c']
];

function renderIntroLine(parts) {
  if (parts.length === 4) {
    return line([span(parts[0], parts[1]), span(parts[2], parts[3])]);
  }
  return line([span(parts[0], parts[1])]);
}

async function playIntro() {
  const played = sessionStorage.getItem('bm-intro-played');
  if (reducedMotion || played) {
    INTRO.forEach(renderIntroLine);
    return;
  }
  sessionStorage.setItem('bm-intro-played', '1');
  for (const parts of INTRO) {
    renderIntroLine(parts);
    await new Promise((resolve) => setTimeout(resolve, 240));
  }
}

// ---------- live query handling (states per the plan's interaction table)

async function getJson(path) {
  const response = await fetch(path);
  const degraded = response.headers.get('x-basemouse-degraded') === 'true';
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `${response.status} ${response.statusText}`);
  }
  return { data, degraded };
}

function packExcerpt(pack) {
  const first = pack.entries[0];
  const excerpt = {
    schema: pack.schema,
    entryCount: pack.entryCount,
    totalMatches: pack.totalMatches,
    citations: pack.citations.slice(0, 3).map((c) => c.label),
    first: first
      ? {
          title: first.title,
          relevance: first.relevance?.score,
          checksum: first.provenance?.checksum,
          version: first.provenance?.version
        }
      : null
  };
  return JSON.stringify(excerpt, null, 2);
}

function packActions(pack) {
  const copyBtn = el('button', { text: 'copy json', attrs: { type: 'button' } });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(pack, null, 2));
      copyBtn.textContent = 'copied ✓';
    } catch {
      copyBtn.textContent = 'copy failed — use download';
    }
    setTimeout(() => { copyBtn.textContent = 'copy json'; }, 1800);
  });

  const dlBtn = el('button', { text: 'download', attrs: { type: 'button' } });
  dlBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { attrs: { href: url, download: `basemouse-context-pack-${Date.now()}.json` } });
    a.click();
    URL.revokeObjectURL(url);
  });

  return el('div', { class: 'pack-actions' }, [copyBtn, dlBtn]);
}

async function runQuery(q) {
  if (busy) return;
  const query = q.trim();
  if (!query) return;
  busy = true;
  termInput.value = '';

  line([span('$ ', 'p'), span(`query "${query}"`, 'o')]);
  const pending = line([span('querying… ', 'c'), el('span', { class: 'cursor', attrs: { 'aria-hidden': 'true' } })]);

  try {
    const params = new URLSearchParams({ q: query });
    const search = await getJson(`/api/search?${params}`);
    pending.remove();

    if (search.degraded) {
      line([span('⚠ demo-fallback corpus (live store reconnecting)', 'warn')]);
    }

    if (search.data.count === 0) {
      // Empty state: warmth + a way forward (the chips are the suggestions).
      line([span(`0 matches for "${query}" — try one of the suggestions below`, 'c')]);
      busy = false;
      return;
    }

    for (const result of search.data.results.slice(0, 5)) {
      line([
        span('▸ ', 'p'),
        span(`${result.title}`, 'o'),
        span(`  · ${result.type} · score ${result.score}`, 'c')
      ]);
    }
    if (search.data.count > 5) {
      line([span(`… ${search.data.count - 5} more match${search.data.count - 5 === 1 ? '' : 'es'}`, 'c')]);
    }

    const packParams = new URLSearchParams({ q: query, limit: '4' });
    const pack = await getJson(`/api/context-pack?${packParams}`);
    lastPack = pack.data;

    line([span(`pack: ${pack.data.entryCount} entries · ${pack.data.citations.length} citations · checksummed`, 'k')]);
    const pre = el('pre', { text: packExcerpt(pack.data) });
    const full = el('details', {}, [
      el('summary', { text: 'open full pack json' }),
      el('pre', { text: JSON.stringify(pack.data, null, 2) })
    ]);
    termLog.append(pre, packActions(pack.data), full);
    termLog.scrollTop = termLog.scrollHeight;
  } catch (error) {
    pending.remove();
    // Error state: named, recoverable, prompt stays usable.
    line([span(`× ${error.message} — retry, the prompt is still live`, 'err')]);
  }
  busy = false;
}

if (termForm) {
  termForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runQuery(termInput.value);
  });
}

document.querySelectorAll('.chip').forEach((button) => {
  button.addEventListener('click', () => {
    termInput.value = button.dataset.query;
    runQuery(button.dataset.query);
  });
});

// ---------- live status (topbar)

async function loadLiveStatus() {
  if (!liveStatusEl) return;
  const text = liveStatusEl.querySelector('.live-text');
  try {
    const res = await fetch('/healthz');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error('unhealthy');
    const ready = await fetch('/readyz').then((r) => r.json()).catch(() => null);
    if (ready && ready.degraded) {
      liveStatusEl.dataset.state = 'degraded';
      if (text) text.textContent = 'degraded — demo docs';
    } else {
      liveStatusEl.dataset.state = 'live';
      const docs = Number(body.documents);
      if (text) text.textContent = Number.isFinite(docs) ? `all systems nominal · ${docs} docs` : 'all systems nominal';
    }
  } catch {
    liveStatusEl.dataset.state = 'down';
    if (text) text.textContent = 'status unavailable';
  }
}

// ---------- copy-curl

async function copyCurl() {
  const source = document.querySelector('#api-curl');
  if (!source || !copyCurlEl) return;
  const original = copyCurlEl.textContent;
  const flash = (label, state) => {
    copyCurlEl.dataset.state = state;
    copyCurlEl.textContent = label;
    setTimeout(() => {
      copyCurlEl.textContent = original;
      delete copyCurlEl.dataset.state;
    }, 1600);
  };
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    flash('copied ✓', 'done');
  } catch {
    flash('copy failed — select manually', 'error');
  }
}
if (copyCurlEl) copyCurlEl.addEventListener('click', copyCurl);

// ---------- capability stat count-up (motion 2 — once, on scroll into view)

function countUp(node) {
  const target = Number(node.dataset.count);
  const suffix = node.dataset.suffix || '';
  if (!Number.isFinite(target) || reducedMotion) {
    node.textContent = `${node.dataset.count}${suffix}`;
    return;
  }
  const steps = 24;
  let step = 0;
  const tick = () => {
    step += 1;
    node.textContent = `${Math.round((target * step) / steps)}${suffix}`;
    if (step < steps) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const statObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      countUp(entry.target);
      statObserver.unobserve(entry.target);
    }
  }
}, { threshold: 0.6 });
document.querySelectorAll('.stat b[data-count]').forEach((node) => statObserver.observe(node));

// ---------- boot

loadLiveStatus();
playIntro();
