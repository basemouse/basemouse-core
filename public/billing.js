// Pricing UI: loads the browser-safe billing config from /api/billing/config,
// renders the tiers, and starts Stripe Checkout via POST /api/checkout. All
// content goes through textContent (no innerHTML), matching app.js.

const tiersEl = document.querySelector('#pricing-tiers');
const noteEl = document.querySelector('#pricing-note');

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

function setNote(message, kind = 'info') {
  if (!noteEl) return;
  noteEl.textContent = message || '';
  noteEl.dataset.kind = kind;
}

async function startCheckout(tierId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Redirecting…';
  setNote('Starting secure checkout…');
  try {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: tierId })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      throw new Error(data.message || data.error || 'Checkout is unavailable right now.');
    }
    window.location.assign(data.url);
  } catch (error) {
    setNote(error.message, 'error');
    button.disabled = false;
    button.textContent = original;
  }
}

function tierCard(tier, contactSalesUrl) {
  const features = el(
    'ul',
    { class: 'tier-features' },
    tier.features.map((feature) => el('li', { text: feature }))
  );

  let cta;
  if (tier.action === 'checkout') {
    cta = el('button', { class: 'button primary tier-cta', text: `Start with ${tier.name}` });
    cta.addEventListener('click', () => startCheckout(tier.id, cta));
  } else if (tier.action === 'link') {
    // Open-core tier: link out to GitHub/docs. Never touches Stripe.
    cta = el('a', {
      class: 'button secondary tier-cta',
      text: tier.actionLabel || 'View on GitHub',
      attrs: {
        href: tier.actionUrl || 'https://github.com/basemouse/basemouse-core',
        rel: 'noopener'
      }
    });
  } else {
    cta = el('a', {
      class: 'button secondary tier-cta',
      text: 'Contact sales',
      attrs: { href: contactSalesUrl || 'mailto:devsupport@basemouse.com?subject=BaseMouse' }
    });
  }

  return el('article', { class: tier.highlighted ? 'tier tier--highlighted' : 'tier' }, [
    tier.highlighted ? el('span', { class: 'tier-badge', text: 'Most popular' }) : null,
    el('h3', { class: 'tier-name', text: tier.name }),
    el('p', { class: 'tier-price' }, [
      el('strong', { text: tier.price }),
      tier.cadence ? el('span', { class: 'tier-cadence', text: ` ${tier.cadence}` }) : null
    ]),
    el('p', { class: 'tier-tagline', text: tier.tagline }),
    features,
    cta
  ]);
}

async function loadPricing() {
  if (!tiersEl) return;
  try {
    const response = await fetch('/api/billing/config');
    const config = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(config.tiers)) {
      throw new Error('Could not load pricing.');
    }
    const cards = config.tiers.map((tier) => tierCard(tier, config.contactSalesUrl));
    tiersEl.replaceChildren(...cards);
    if (!config.enabled) {
      setNote('Self-serve checkout is being set up — contact sales to get started today.', 'warn');
    } else {
      setNote('');
    }
  } catch (error) {
    tiersEl.replaceChildren(el('p', { class: 'hint', text: 'Pricing is temporarily unavailable.' }));
    setNote(error.message, 'error');
  }
}

loadPricing();
