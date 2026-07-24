-- M1 schema: documents / revisions / keys domains only (incremental store
-- interface per docs/designs/real-service-core.md OV-E5.1). Quota usage
-- tables land with M2, webhook tables with M4. Idempotent: every statement
-- is IF NOT EXISTS / ON CONFLICT DO NOTHING, so the runner can apply the
-- whole directory on every deploy.
--
-- Already applied to the Supabase project as migration
-- `m1_real_service_core_init` (2026-06-11); kept here as the canonical copy
-- the CI migrate job runs against rehearsal and prod databases.

create table if not exists keys (
  id text primary key default gen_random_uuid()::text,
  key_hash text unique,
  plan text not null default 'demo',
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  cancelled_at timestamptz,
  last_event_created bigint,
  doc_count integer not null default 0,
  storage_bytes bigint not null default 0
);

insert into keys (id, plan, status) values ('public', 'system', 'system')
on conflict (id) do nothing;

create table if not exists documents (
  workspace_id text not null references keys(id),
  id text not null,
  title text not null,
  type text not null,
  tags jsonb not null default '[]'::jsonb,
  body text not null,
  links jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  author text,
  created_at text,
  updated_at text,
  checksum text not null,
  source jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  primary key (workspace_id, id)
);

create index if not exists documents_workspace_idx on documents (workspace_id);
create index if not exists documents_fts_idx
  on documents using gin (to_tsvector('english', title || ' ' || body));

create table if not exists revisions (
  id bigint generated always as identity primary key,
  workspace_id text not null,
  document_id text not null,
  version integer not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, document_id) references documents (workspace_id, id),
  unique (workspace_id, document_id, version)
);

create table if not exists key_audit (
  id bigint generated always as identity primary key,
  key_id text not null references keys(id),
  action text not null,
  actor text not null,
  created_at timestamptz not null default now()
);

alter table keys enable row level security;
alter table documents enable row level security;
alter table revisions enable row level security;
alter table key_audit enable row level security;
