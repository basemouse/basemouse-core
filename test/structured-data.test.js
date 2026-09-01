import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TIERS } from '../src/billing.js';

// Structured data (JSON-LD) is what AI crawlers and answer engines read to
// identify the product, its price, and its entity links. It duplicates facts
// that live elsewhere in the repo, so these tests are the guard against drift:
// a price change in src/billing.js must fail here until the markup follows.

const PUBLIC_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));

function htmlFiles() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.html') ? [full] : [];
    });
  return walk(PUBLIC_DIR);
}

function readPage(relative) {
  return readFileSync(join(PUBLIC_DIR, relative), 'utf8');
}

// Tolerant of attribute order and quote style. A stricter pattern would let a
// harmless markup edit silently hide a block, and every assertion below would
// then pass against nothing at all.
function jsonLdBlocks(html) {
  const blocks = [];
  // `\s` before `type=` on purpose: `\b` would also match inside `data-type=`.
  const pattern = /<script\b[^>]*\stype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match !== null) {
    blocks.push(JSON.parse(match[1]));
    match = pattern.exec(html);
  }
  // Guard against the extractor going blind: every ld+json mention in the file
  // must correspond to a block we actually parsed.
  const mentions = (html.match(/application\/ld\+json/g) ?? []).length;
  assert.equal(blocks.length, mentions, 'a JSON-LD block was present but not extracted');
  return blocks;
}

function nodesOfType(html, type) {
  return jsonLdBlocks(html)
    .flatMap((block) => (Array.isArray(block['@graph']) ? block['@graph'] : [block]))
    .filter((node) => node['@type'] === type);
}

test('every JSON-LD block on every public page parses as JSON', () => {
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    assert.doesNotThrow(() => jsonLdBlocks(html), `invalid JSON-LD in ${file}`);
  }
});

test('the homepage publishes an Organization with entity links', () => {
  const [organization, ...extra] = nodesOfType(readPage('index.html'), 'Organization');

  assert.ok(organization, 'homepage has no Organization node');
  assert.equal(extra.length, 0, 'more than one top-level Organization node');
  assert.equal(organization.url, 'https://basemouse.com/');
  assert.ok(Array.isArray(organization.sameAs) && organization.sameAs.length > 0);
  // sameAs is the check AI readiness audits fail us on. Every entry must be an
  // absolute URL to a profile we actually control or are actually listed on.
  for (const link of organization.sameAs) {
    assert.match(link, /^https:\/\//, `sameAs entry is not an absolute https URL: ${link}`);
  }
  assert.ok(organization.sameAs.includes('https://github.com/basemouse'));
});

test('homepage SoftwareApplication offers match the billing tiers', () => {
  const [software] = nodesOfType(readPage('index.html'), 'SoftwareApplication');
  assert.ok(software, 'homepage has no SoftwareApplication node');

  // A tier is representable as a schema.org Offer only if its price is a real
  // amount. "Custom" (Enterprise) is contact-sales and must not be published
  // with an invented number.
  const priced = TIERS.filter((tier) => /^\$\d+$/.test(tier.price));
  const offers = software.offers ?? [];

  assert.equal(offers.length, priced.length, 'offer count does not match priced tiers');

  for (const tier of priced) {
    const offer = offers.find((candidate) => candidate.name === tier.name);
    assert.ok(offer, `no Offer published for the ${tier.name} tier`);
    assert.equal(offer.price, tier.price.replace('$', ''), `${tier.name} price drifted from src/billing.js`);
    assert.equal(offer.priceCurrency, 'USD');
  }

  const unpriced = TIERS.filter((tier) => !/^\$\d+$/.test(tier.price));
  for (const tier of unpriced) {
    assert.ok(
      !offers.some((offer) => offer.name === tier.name),
      `${tier.name} has no fixed price and must not be published as a priced Offer`
    );
  }
});

test('homepage FAQ markup and FAQPage structured data stay in sync', () => {
  const html = readPage('index.html');
  const [faq] = nodesOfType(html, 'FAQPage');
  assert.ok(faq, 'homepage has no FAQPage node');

  const faqSection = html.slice(html.indexOf('<section class="faq"'), html.indexOf('</section>', html.indexOf('<section class="faq"')));
  const summaries = [...faqSection.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((match) => match[1].trim());

  assert.ok(summaries.length > 0, 'no visible FAQ questions found on the homepage');
  assert.equal(
    faq.mainEntity.length,
    summaries.length,
    'FAQPage question count does not match the visible <details> questions'
  );
  // Google requires the structured question to be the question the user sees.
  for (const summary of summaries) {
    assert.ok(
      faq.mainEntity.some((entry) => entry.name === summary),
      `visible FAQ question is missing from JSON-LD: ${summary}`
    );
  }
  for (const entry of faq.mainEntity) {
    assert.ok(entry.acceptedAnswer?.text?.length > 0, `FAQ answer is empty for: ${entry.name}`);
  }
});

test('every sitemap URL is absolute, unique, and resolves to a file that exists', () => {
  const xml = readFileSync(join(PUBLIC_DIR, 'sitemap.xml'), 'utf8');

  // Structural check, not a full XML parse (no parser dependency): every <url>
  // must carry exactly one <loc>, and every <loc> must point at a file we
  // actually ship. A sitemap entry for a page that 404s is worse than no entry.
  const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  assert.ok(urlBlocks.length > 0, 'sitemap contains no <url> entries');
  assert.equal(
    urlBlocks.length,
    (xml.match(/<loc>/g) ?? []).length,
    'a <url> entry is missing its <loc>'
  );

  const locations = urlBlocks.map((block) => {
    const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1];
    assert.ok(loc, 'a <url> entry has no <loc>');
    assert.match(loc, /^https:\/\/basemouse\.com\//, `sitemap <loc> is not an absolute site URL: ${loc}`);
    return loc;
  });

  assert.equal(new Set(locations).size, locations.length, 'sitemap contains a duplicate <loc>');

  for (const loc of locations) {
    const path = new URL(loc).pathname;
    // A trailing slash is a directory request; the server serves its index.html.
    const relative = path.endsWith('/') ? `${path}index.html` : path;
    assert.ok(
      existsSync(join(PUBLIC_DIR, relative.replace(/^\//, ''))),
      `sitemap lists ${loc} but public${relative} does not exist`
    );
  }
});

test('the comparison page is published, discoverable, and marked up', () => {
  const html = readPage('compare.html');

  assert.match(html, /<link rel="canonical" href="https:\/\/basemouse\.com\/compare\.html" \/>/);
  assert.ok(nodesOfType(html, 'FAQPage').length === 1, 'comparison page has no FAQPage node');
  assert.ok(nodesOfType(html, 'ItemList').length === 1, 'comparison page has no ItemList of alternatives');

  // Discovery surfaces: a comparison page nothing links to is a page no crawler
  // finds. All three must list it.
  assert.match(readPage('index.html'), /href="\/compare\.html"/);
  assert.match(readFileSync(join(PUBLIC_DIR, 'sitemap.xml'), 'utf8'), /https:\/\/basemouse\.com\/compare\.html/);
  assert.match(readFileSync(join(PUBLIC_DIR, 'llms.txt'), 'utf8'), /https:\/\/basemouse\.com\/compare\.html/);
});
