-- M2 schema: monthly usage counters + Stripe webhook idempotency
-- (docs/designs/real-service-core.md — usage/quota store domains land at M2).
-- Idempotent; applied to Supabase as `m2_entitlements` (2026-06-11).

create table if not exists usage (
  key_id text not null references keys(id),
  month text not null,            -- calendar UTC month, 'YYYY-MM'
  pack_pulls integer not null default 0,
  primary key (key_id, month)
);

create table if not exists stripe_events (
  event_id text primary key,
  created bigint not null,
  processed_at timestamptz not null default now()
);

alter table usage enable row level security;
alter table stripe_events enable row level security;

-- One key record per Stripe customer: makes the webhook/claim upsert race
-- resolvable with ON CONFLICT instead of check-then-insert.
create unique index if not exists keys_stripe_customer_idx
  on keys (stripe_customer_id) where stripe_customer_id is not null;
