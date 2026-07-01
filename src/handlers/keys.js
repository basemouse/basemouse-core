// Key lifecycle handlers: claim (payment → key, the load-bearing flow),
// rotate, usage, and the Billing Portal session. Single-concern module
// (eng-review decision 3A). The key record IS the account; its id is the
// workspace id.
//
//   checkout.session.completed ─► webhook upserts pending_claim record
//   success page (/claim)      ─► POST /api/keys/claim {sessionId}
//                                  verify session WITH STRIPE, upsert if the
//                                  webhook is late, generate key, hash it,
//                                  activate — plaintext returned EXACTLY ONCE

import { generateKey, hashKey } from '../auth.js';
import { fetchCheckoutSession, findTier, createPortalSession } from '../billing.js';
import {
  AlreadyClaimedError,
  InvalidSessionError,
  StripeUnavailableError,
  UnauthorizedError,
  ValidationError
} from '../errors.js';
import { currentMonth, limitsForPlan } from '../quota.js';

export async function claimKeyHandler(store, billing, payload, { fetchImpl } = {}) {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) throw new ValidationError('sessionId is required');
  if (!billing.secretKey) throw new StripeUnavailableError(new Error('billing not configured'));

  // Verify with Stripe directly — the claim side never trusts a session_id.
  let result;
  try {
    result = await fetchCheckoutSession(billing, sessionId, fetchImpl ? { fetchImpl } : {});
  } catch (error) {
    throw new StripeUnavailableError(error);
  }
  if (!result.ok) {
    if (result.status >= 500) throw new StripeUnavailableError(new Error(result.error));
    throw new InvalidSessionError();
  }

  const session = result.session;
  if (session.payment_status !== 'paid' || !session.customer) {
    throw new InvalidSessionError();
  }

  // Plan derivation: client_reference_id (the tier id checkout stamps).
  const tier = findTier(billing, session.client_reference_id);
  const plan = tier ? tier.id : 'starter';

  // Claim race (success page beats webhook): verified UPSERT — whichever of
  // webhook/claim lands first creates the record, the other is a no-op.
  const pending = await store.upsertPendingKey({
    customerId: typeof session.customer === 'string' ? session.customer : session.customer.id,
    subscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
    plan,
    eventCreated: session.created ?? null
  });

  const plaintext = generateKey();
  const key = await store.activateKey(pending.id, hashKey(plaintext), 'claim-endpoint');
  // AlreadyClaimedError propagates from activateKey when status isn't
  // pending_claim — a refresh after a successful claim, or a double-click.

  return {
    status: 201,
    body: {
      key: plaintext, // shown exactly once; only the hash is stored
      workspace: key.id,
      plan: key.plan,
      message: 'Save this key now — it is shown exactly once and cannot be retrieved.'
    }
  };
}

export async function rotateKeyHandler(store, auth) {
  if (!auth) throw new UnauthorizedError('rotation requires the current key');
  const plaintext = generateKey();
  await store.rotateKeyHash(auth.keyId, hashKey(plaintext), 'rotate-endpoint');
  return {
    status: 200,
    body: {
      key: plaintext,
      workspace: auth.keyId,
      message: 'Old key is invalid immediately. Save this one now — it is shown exactly once.'
    }
  };
}

export async function usageHandler(store, auth, planLimits) {
  if (!auth) throw new UnauthorizedError('usage requires an API key');
  const month = currentMonth();
  const usage = await store.getUsage(auth.keyId, month);
  const limits = limitsForPlan(planLimits, usage?.plan || auth.plan);
  return {
    status: 200,
    body: {
      workspace: auth.keyId,
      plan: usage?.plan || auth.plan,
      status: usage?.status || auth.status,
      month,
      documents: { used: usage?.docCount ?? 0, limit: limits.maxDocuments },
      packPulls: { used: usage?.packPulls ?? 0, limit: limits.packPullsPerMonth },
      storageBytes: { used: usage?.storageBytes ?? 0, limit: limits.maxStorageBytes }
    }
  };
}

export async function portalHandler(store, billing, auth, { fetchImpl } = {}) {
  if (!auth) throw new UnauthorizedError('the billing portal requires an API key');
  const key = await store.getKeyById(auth.keyId);
  if (!key?.stripeCustomerId) {
    throw new ValidationError('this key has no Stripe customer (script-issued keys manage billing with the operator)');
  }
  try {
    const session = await createPortalSession(billing, key.stripeCustomerId, fetchImpl ? { fetchImpl } : {});
    return { status: 200, body: { url: session.url } };
  } catch (error) {
    throw new StripeUnavailableError(error);
  }
}
