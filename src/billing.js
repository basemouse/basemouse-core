// Env-driven Stripe billing for BaseMouse.
//
// Zero dependencies: talks to Stripe with built-in `fetch` + `URLSearchParams`,
// so the app stays installable without the Stripe SDK. Everything sensitive
// (the API key, resolved price IDs) lives in environment variables and is kept
// server-side. `publicBillingConfig` produces the browser-safe view.
//
// Safe by default: when the Stripe env vars are absent, billing is "disabled"
// and the product renders a contact-sales state instead of crashing. Nothing
// here stores customer or payment data — Stripe Checkout owns that.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const DEFAULT_STRIPE_API_VERSION = '2025-06-30.basil';

// Static tier catalog. Price IDs are NOT hardcoded — each purchasable tier
// names the env var that supplies its Stripe Price ID (`priceEnv`). Tiers with
// `priceEnv: null` are contact-sales only and never hit Checkout.
//
// The open-core tier (`cta.action === 'link'`) is special: a payment buys
// nothing because the core is MIT-licensed and self-hosted. Its CTA points at
// the public repo + docs and NEVER touches Stripe Checkout or sales.
export const TIERS = [
  {
    id: 'open',
    name: 'Open Source',
    priceEnv: null,
    price: '$0',
    cadence: 'self-hosted',
    tagline: 'Run the MIT-licensed core yourself — free, no card.',
    // Open-core CTA: link out to GitHub/docs, never Stripe. The resolved URL
    // is supplied by loadBillingConfig (env-overridable).
    cta: { action: 'link', label: 'Get it on GitHub' },
    features: [
      'Self-hosted via Docker / Docker Compose',
      'Import, search & context-pack API',
      'Graph-aware relationships & provenance',
      'Append-only history & audit trail',
      'Slack + local-LLM connector example'
    ]
  },
  {
    id: 'starter',
    name: 'Starter',
    priceEnv: 'STRIPE_PRICE_STARTER',
    price: '$29',
    cadence: 'per month',
    tagline: 'Ground a single agent in trusted, cited context.',
    features: [
      'Context-pack API with citations & provenance',
      'Lexical + faceted retrieval',
      'Up to 2,000 documents',
      'Community support'
    ]
  },
  {
    id: 'team',
    name: 'Team',
    priceEnv: 'STRIPE_PRICE_TEAM',
    price: '$99',
    cadence: 'per month',
    tagline: 'Govern an agent fleet on a shared knowledge substrate.',
    highlighted: true,
    features: [
      'Everything in Starter',
      'Up to 20,000 documents & full version history',
      'Graph-aware relationships & provenance',
      'MeshAI governance hooks',
      'Priority support'
    ]
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceEnv: null,
    price: 'Custom',
    cadence: '',
    tagline: 'Self-hosted, SSO, audit trails, and volume pricing.',
    features: [
      'Everything in Team',
      'Self-hosted / VPC deployment',
      'SSO & audit logging',
      'Dedicated support & SLA'
    ]
  }
];

const DEFAULT_CONTACT_SALES_URL =
  'mailto:devsupport@basemouse.com?subject=BaseMouse%20Enterprise';
const DEFAULT_APP_BASE_URL = 'https://basemouse.com';
// Where the open-core CTA points. A public URL (not a secret); env-overridable
// so self-hosters can re-point it at their own fork/docs.
const DEFAULT_OPEN_SOURCE_URL = 'https://github.com/basemouse/basemouse-core';

// Build the server-side billing configuration from environment variables.
// Pure with respect to its `env` argument so tests can pass a fixture object.
export function loadBillingConfig(env = process.env) {
  // Accept either a restricted key (rk_, preferred) or a secret key (sk_).
  const secretKey = stringOrNull(env.STRIPE_SECRET_KEY);
  const appBaseUrl = stringOrNull(env.APP_BASE_URL) || DEFAULT_APP_BASE_URL;
  // Checkout must be explicitly switched on. Until paid plans are linked to
  // entitlements (API keys, quotas), a payment buys nothing — so even with
  // Stripe fully configured, tiers render contact-sales unless the operator
  // sets CHECKOUT_ENABLED=true. (M0 integrity gate; M2 flips it on.)
  const checkoutEnabled = stringOrNull(env.CHECKOUT_ENABLED) === 'true';

  const openSourceUrl = stringOrNull(env.OPEN_SOURCE_URL) || DEFAULT_OPEN_SOURCE_URL;

  const tiers = TIERS.map((tier) => {
    const priceId = tier.priceEnv ? stringOrNull(env[tier.priceEnv]) : null;
    const openSource = tier.cta?.action === 'link';
    // A tier is purchasable only when checkout is switched on AND we have
    // BOTH an API key and its price. The open-core tier is never purchasable.
    const checkout = Boolean(!openSource && checkoutEnabled && secretKey && priceId);
    return {
      id: tier.id,
      name: tier.name,
      price: tier.price,
      cadence: tier.cadence,
      tagline: tier.tagline,
      features: tier.features.slice(),
      highlighted: Boolean(tier.highlighted),
      priceId,
      checkout,
      openSource,
      ctaLabel: openSource ? tier.cta.label : null
    };
  });

  const enabled = tiers.some((tier) => tier.checkout);

  return {
    enabled,
    secretKey, // server-only — never serialize this to the browser
    webhookSecret: stringOrNull(env.STRIPE_WEBHOOK_SECRET), // server-only
    publishableKey: stringOrNull(env.STRIPE_PUBLISHABLE_KEY),
    stripeApiVersion: stringOrNull(env.STRIPE_API_VERSION) || DEFAULT_STRIPE_API_VERSION,
    pricingTableId: stringOrNull(env.STRIPE_PRICING_TABLE_ID),
    contactSalesUrl: stringOrNull(env.BILLING_CONTACT_URL) || DEFAULT_CONTACT_SALES_URL,
    openSourceUrl,
    // Success lands on the claim page — the designed five-state flow that
    // exchanges the session for the API key (shown exactly once).
    successUrl:
      stringOrNull(env.BILLING_SUCCESS_URL) ||
      `${appBaseUrl}/claim?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl:
      stringOrNull(env.BILLING_CANCEL_URL) || `${appBaseUrl}/?checkout=cancelled#pricing`,
    tiers
  };
}

// Browser-safe projection of the billing config. NEVER includes the API key or
// resolved price IDs — the browser references tiers by id and the server maps
// id -> price during Checkout creation.
export function publicBillingConfig(config) {
  return {
    enabled: config.enabled,
    publishableKey: config.publishableKey,
    pricingTableId: config.pricingTableId,
    contactSalesUrl: config.contactSalesUrl,
    openSourceUrl: config.openSourceUrl,
    tiers: config.tiers.map((tier) => {
      // 'link' => open-core, link out to GitHub/docs (never Stripe);
      // 'checkout' => can start Stripe Checkout; 'contact' => contact sales.
      let action = 'contact';
      if (tier.openSource) action = 'link';
      else if (tier.checkout) action = 'checkout';
      const projected = {
        id: tier.id,
        name: tier.name,
        price: tier.price,
        cadence: tier.cadence,
        tagline: tier.tagline,
        features: tier.features.slice(),
        highlighted: tier.highlighted,
        action
      };
      if (tier.openSource) {
        projected.actionUrl = config.openSourceUrl;
        projected.actionLabel = tier.ctaLabel || 'View on GitHub';
      }
      return projected;
    })
  };
}

// Look up a configured tier by id. Returns null when unknown.
export function findTier(config, tierId) {
  const id = String(tierId ?? '').trim();
  if (!id) return null;
  return config.tiers.find((tier) => tier.id === id) || null;
}

// Create a Stripe Checkout Session for a purchasable tier and return its URL.
// `fetchImpl` is injectable so the server route can be tested without network.
// Follows Stripe best practices: subscription mode, dynamic payment methods
// (no payment_method_types), Price IDs (not legacy plans).
export async function createCheckoutSession(config, tierId, { fetchImpl = fetch } = {}) {
  if (!config.enabled) {
    throw new Error('billing_disabled');
  }
  const tier = findTier(config, tierId);
  if (!tier || !tier.checkout) {
    throw new Error(`tier_not_purchasable: ${tierId}`);
  }

  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', tier.priceId);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', config.successUrl);
  form.set('cancel_url', config.cancelUrl);
  form.set('client_reference_id', tier.id);
  // Stamp the SUBSCRIPTION metadata too: subscription.updated/deleted events
  // carry no client_reference_id, so the tier must travel on the
  // subscription itself for later lifecycle events to self-identify (OV-E4).
  form.set('subscription_data[metadata][tier]', tier.id);
  // NOTE: intentionally no payment_method_types — let Stripe pick eligible
  // methods dynamically from Dashboard settings.

  const response = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': config.stripeApiVersion
    },
    body: form.toString()
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `stripe responded ${response.status}`;
    throw new Error(`stripe_checkout_failed: ${message}`);
  }
  if (!data || typeof data.url !== 'string') {
    throw new Error('stripe_checkout_failed: missing session url');
  }
  return { url: data.url, id: data.id || null };
}

// Fetch a Checkout Session from Stripe — the claim endpoint's verification
// path (the claim side never trusts a session_id without asking Stripe).
export async function fetchCheckoutSession(config, sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Stripe-Version': config.stripeApiVersion
      }
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status, error: data?.error?.message || `stripe responded ${response.status}` };
  }
  return { ok: true, session: data };
}

// Create a Stripe Billing Portal session — the customer-facing cancel and
// payment-management surface (OV-E4): one hosted page, zero UI to build.
export async function createPortalSession(config, customerId, { fetchImpl = fetch } = {}) {
  const form = new URLSearchParams();
  form.set('customer', customerId);
  form.set('return_url', `${config.successUrl.split('?')[0] || 'https://basemouse.com'}`);
  const response = await fetchImpl(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': config.stripeApiVersion
    },
    body: form.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.url !== 'string') {
    throw new Error(`stripe_portal_failed: ${data?.error?.message || response.status}`);
  }
  return { url: data.url };
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
