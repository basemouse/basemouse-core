import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadLicenseConfig, normalizeTier, publicLicenseStatus, TIERS } from '../src/license.js';

test('defaults: no env => open / hosted / unlicensed, never blocks', () => {
  const cfg = loadLicenseConfig({});
  assert.equal(cfg.tier, 'open');
  assert.equal(cfg.selfHosted, false);
  assert.equal(cfg.licensed, false);
  assert.equal(cfg.licenseKey, null);
  assert.equal(cfg.expiresAt, null);
  assert.equal(cfg.expired, null);
});

test('normalizeTier maps known tiers, falls back to open for unknown/blank', () => {
  for (const tier of TIERS) {
    assert.equal(normalizeTier(tier), tier);
    assert.equal(normalizeTier(tier.toUpperCase()), tier);
  }
  assert.equal(normalizeTier('  Team  '), 'team');
  assert.equal(normalizeTier('platinum'), 'open');
  assert.equal(normalizeTier(''), 'open');
  assert.equal(normalizeTier(undefined), 'open');
  assert.equal(normalizeTier(null), 'open');
});

test('reads tier, self-hosted, and license-key presence from env', () => {
  const cfg = loadLicenseConfig({
    BASEMOUSE_LICENSE_KEY: 'bml_secret_value',
    BASEMOUSE_LICENSE_TIER: 'enterprise',
    BASEMOUSE_SELF_HOSTED: 'true'
  });
  assert.equal(cfg.tier, 'enterprise');
  assert.equal(cfg.selfHosted, true);
  assert.equal(cfg.licensed, true);
  assert.equal(cfg.licenseKey, 'bml_secret_value');
});

test('SELF_HOSTED is only true for the literal "true"', () => {
  assert.equal(loadLicenseConfig({ BASEMOUSE_SELF_HOSTED: '1' }).selfHosted, false);
  assert.equal(loadLicenseConfig({ BASEMOUSE_SELF_HOSTED: 'yes' }).selfHosted, false);
  assert.equal(loadLicenseConfig({ BASEMOUSE_SELF_HOSTED: 'TRUE' }).selfHosted, false);
  assert.equal(loadLicenseConfig({ BASEMOUSE_SELF_HOSTED: 'true' }).selfHosted, true);
});

test('expiry: future date is not expired, past date is expired, garbage reports null', () => {
  const now = Date.parse('2026-06-25T00:00:00Z');
  const future = loadLicenseConfig({ BASEMOUSE_LICENSE_EXPIRES_AT: '2027-01-01' }, { now });
  assert.equal(future.expiresAt, '2027-01-01');
  assert.equal(future.expired, false);

  const past = loadLicenseConfig({ BASEMOUSE_LICENSE_EXPIRES_AT: '2025-01-01' }, { now });
  assert.equal(past.expired, true);

  const garbage = loadLicenseConfig({ BASEMOUSE_LICENSE_EXPIRES_AT: 'whenever' }, { now });
  assert.equal(garbage.expiresAt, 'whenever');
  assert.equal(garbage.expired, null);
});

test('publicLicenseStatus never leaks the license key', () => {
  const cfg = loadLicenseConfig({
    BASEMOUSE_LICENSE_KEY: 'bml_super_secret',
    BASEMOUSE_LICENSE_TIER: 'team',
    BASEMOUSE_SELF_HOSTED: 'true',
    BASEMOUSE_LICENSE_EXPIRES_AT: '2099-01-01'
  });
  const status = publicLicenseStatus(cfg);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('bml_super_secret'), 'license key must not appear in public status');
  assert.equal('licenseKey' in status, false);
  assert.deepEqual(status, {
    mode: 'self-hosted',
    selfHosted: true,
    tier: 'team',
    licensed: true,
    source: 'env',
    expiresAt: '2099-01-01',
    expired: false
  });
});

test('publicLicenseStatus reports hosted/open for a bare deployment', () => {
  const status = publicLicenseStatus(loadLicenseConfig({}));
  assert.equal(status.mode, 'hosted');
  assert.equal(status.tier, 'open');
  assert.equal(status.licensed, false);
  assert.equal(status.source, 'none');
});
