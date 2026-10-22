-- Agent Marketing: "My Marketing Photos" library (Oct 22, 2026). Additive only; no existing table is changed except one new nullable column.
-- Private per-user photo library for Agent Marketing. Not tied to any listing, so it never appears in the listing Gallery
-- or on compliance pages. RLS on with no policies = service role only (same as the other agent_marketing tables).
create table if not exists public.agent_marketing_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null default 'upload' check (kind in ('upload','generated')),
  asset_key text not null,
  content_type text,
  label text,
  rights jsonb not null default '{}'::jsonb,   -- ownership attestation: version, text, timestamp, source, note
  project_id uuid references public.agent_marketing_projects(id) on delete set null,  -- set for generated images
  generation jsonb,                            -- generated images: model, prompt, cost
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists agent_marketing_library_user_idx on public.agent_marketing_library (user_id, created_at desc) where deleted_at is null;
alter table public.agent_marketing_library enable row level security;
alter table public.agent_marketing_assets add column if not exists library_id uuid references public.agent_marketing_library(id) on delete set null;
