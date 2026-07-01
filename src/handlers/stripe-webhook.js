// Inbound Stripe webhook: the entitlement side of the payment flow.
// Signature verification uses the official SDK's constructEvent (eng-review
// decision 1A: raw-body handling, timestamp tolerance, and constant-time
// comparison are the SDK's problem, never hand-rolled). Idempotency via the
// stripe_events table; out-of-order subscription events resolve by event
// `created` against keys.last_event_created.
//
//   checkout.session.completed     ─► upsert pending_claim key (plan from
//                                     client_reference_id)
//   customer.subscription.updated  ─► plan/status refresh (tier from
//                                     subscription metadata — OV-E4)
//   customer.subscription.deleted  ─► status=read_only + cancelled_at
//                                     (90-day grace; reads/export keep working)
//
// Malformed/unknown events are logged and ACKed with 200 — never a
// retry-loop (error registry).

import Stripe from 'stripe';
import { WebhookSignatureError } from '../errors.js';

// constructEvent is pure crypto — the api key is never used for network calls
// here, so a placeholder keeps the verifier constructible without secrets.
const stripeVerifier = new Stripe('sk_offline_verification_only');

export function verifyStripeSignature(rawBody, signatureHeader, webhookSecret) {
  try {
    return stripeVerifier.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
  } catch (error) {
    console.warn(`stripe webhook signature rejected: ${error.message}`);
    throw new WebhookSignatureError();
  }
}

function planFromSubscription(subscription, fallback = null) {
  return subscription?.metadata?.tier || fallback;
}

export async function stripeWebhookHandler(store, billing, rawBody, signatureHeader) {
  if (!billing.webhookSecret) {
    // Webhook endpoint not configured — ack so Stripe doesn't retry forever,
    // but log loudly: events are being dropped.
    console.error('stripe webhook received but STRIPE_WEBHOOK_SECRET is not set — event dropped');
    return { status: 200, body: { received: true, processed: false } };
  }

  const event = verifyStripeSignature(rawBody, signatureHeader, billing.webhookSecret);

  // Idempotency: each event id processes exactly once.
  const isNew = await store.markStripeEvent(event.id, event.created);
  if (!isNew) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.payment_status !== 'paid' || !session.customer) break;
      await store.upsertPendingKey({
        customerId: typeof session.customer === 'string' ? session.customer : session.customer.id,
        subscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
        plan: session.client_reference_id || 'starter',
        eventCreated: event.created
      });
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
      if (!customerId) break;
      const cancelled = subscription.status === 'canceled' || subscription.cancel_at_period_end === true;
      // An active subscription update REACTIVATES a read_only key (e.g. the
      // customer un-cancels in the Billing Portal) — and clears cancelled_at.
      await store.updateSubscriptionState(customerId, {
        plan: planFromSubscription(subscription),
        status: cancelled ? 'read_only' : 'active',
        cancelledAt: cancelled ? new Date(event.created * 1000).toISOString() : undefined,
        eventCreated: event.created
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
      if (!customerId) break;
      // Cancellation policy (OV5): read-only immediately, 90-day grace,
      // export available throughout; purge is a later admin script.
      await store.updateSubscriptionState(customerId, {
        status: 'read_only',
        cancelledAt: new Date(event.created * 1000).toISOString(),
        eventCreated: event.created
      });
      break;
    }
    default:
      // Unknown event types are logged and ACKed — never an error loop.
      console.log(`stripe webhook: ignoring event type ${event.type}`);
  }

  return { status: 200, body: { received: true } };
}
