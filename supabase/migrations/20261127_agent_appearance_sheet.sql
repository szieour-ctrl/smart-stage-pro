-- Agent Appearance Sheet, slice 1 (Nov 27, 2026): tables only. ADDITIVE: three new tables and three small functions. Nothing is dropped,
-- renamed or rewritten, and no shipped code reads them yet, so it is safe to run before or after the matching code.
-- Run it through the Supabase connector (or the SQL editor).
-- RLS is on with NO policies: service role only, same as the other agent_marketing tables.
--
-- POOL RULE (Sam, Nov 27): a sheet starts with 12 iterations (provider calls that return an image). When they run out the subscriber pays
-- 5 Images to continue and gets 12 MORE, use it or lose it: a refill SETS the remaining count to 12 (unused calls never carry over).
-- Approved stages stay; the sheet is never restarted. A failed provider call is refunded to the pool.
create table if not exists public.agent_appearance_sheets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  status text not null default 'setup' check (status in ('setup','in_progress','complete')),
  pool_remaining integer not null default 12 check (pool_remaining >= 0 and pool_remaining <= 12),
  pool_refills integer not null default 0 check (pool_refills >= 0),
  style_dna text,                           -- the subscriber's chosen style; presentation only, never overrides an approved garment
  vision_attributes jsonb,                  -- Phase A: only what is visible in the headshot (face, hair, facial hair, shirt)
  approved_wardrobe jsonb,                  -- Phase B: set after the full-body master is approved
  consent_at timestamptz,
  consent_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_agent_appearance_sheets_user on public.agent_appearance_sheets (user_id);
alter table public.agent_appearance_sheets enable row level security;

create table if not exists public.agent_appearance_assets (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references public.agent_appearance_sheets(id) on delete cascade,
  user_id uuid not null references public.users(id),
  stage text not null check (stage in ('original','enhanced_headshot','three_quarter','full_body','angles','expressions','poses')),
  kind text not null check (kind in ('original','single','composite','crop')),
  parent_id uuid references public.agent_appearance_assets(id),   -- lineage: what this was made from (a crop's parent is its composite)
  panel_index integer,                      -- crops only: position in the composite, left to right, top to bottom
  s3_key text not null,                     -- private prefix smart-stage-appearance/{user}/{sheet}/...
  content_type text,
  width integer,
  height integer,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  call_id uuid,                             -- the ledger row that produced it
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_appearance_assets_sheet on public.agent_appearance_assets (sheet_id, stage, created_at);
alter table public.agent_appearance_assets enable row level security;

-- One row per provider call, kept for audit: stage, attempt, request id, quoted and estimated cost, inputs, output, errors.
create table if not exists public.agent_appearance_calls (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references public.agent_appearance_sheets(id) on delete cascade,
  user_id uuid not null references public.users(id),
  stage text not null,
  attempt integer not null default 1,
  provider text not null,                   -- vendor-neutral label, e.g. 'upscale' or 'image_edit'; never shown to subscribers
  endpoint text not null,
  request_id text,
  status text not null default 'started' check (status in ('started','ok','failed','refunded')),
  pool_counted boolean not null default false,
  quoted_usd numeric(8,4),
  estimated_usd numeric(8,4),               -- from the published rate; fal's response carries no cost
  input_asset_ids uuid[] not null default '{}',
  output_asset_id uuid,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_agent_appearance_calls_sheet on public.agent_appearance_calls (sheet_id, started_at);
alter table public.agent_appearance_calls enable row level security;

-- Atomic pool moves. debit returns the remaining count after the debit, or -1 when the pool is empty (the caller then offers the 5-Image refill).
create or replace function public.appearance_pool_debit(p_sheet uuid) returns integer language plpgsql as $$
declare r integer;
begin
  update public.agent_appearance_sheets set pool_remaining = pool_remaining - 1, updated_at = now()
   where id = p_sheet and pool_remaining > 0 returning pool_remaining into r;
  return coalesce(r, -1);
end $$;
create or replace function public.appearance_pool_refund(p_sheet uuid) returns integer language plpgsql as $$
declare r integer;
begin
  update public.agent_appearance_sheets set pool_remaining = least(12, pool_remaining + 1), updated_at = now()
   where id = p_sheet returning pool_remaining into r;
  return coalesce(r, -1);
end $$;
-- Refill SETS the pool to 12 (unused calls are lost) and counts the refill. The 5-Image charge is taken by the caller before this runs.
create or replace function public.appearance_pool_refill(p_sheet uuid) returns integer language plpgsql as $$
declare r integer;
begin
  update public.agent_appearance_sheets set pool_remaining = 12, pool_refills = pool_refills + 1, updated_at = now()
   where id = p_sheet returning pool_remaining into r;
  return coalesce(r, -1);
end $$;
revoke all on function public.appearance_pool_debit(uuid), public.appearance_pool_refund(uuid), public.appearance_pool_refill(uuid) from public, anon, authenticated;
