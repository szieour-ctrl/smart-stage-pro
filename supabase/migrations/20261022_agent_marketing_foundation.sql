-- Agent Marketing foundation (Oct 22, 2026). ADDITIVE ONLY: new tables, new nullable/defaulted columns.
-- Nothing is dropped, renamed or rewritten, and no existing code reads the new objects, so this is safe to run
-- before or after the matching code ships. Run it in the Supabase SQL editor (project dnpaenpwdhjmslymgkse).
-- All new tables have RLS enabled with NO policies: service_role only, same as reel_jobs and marketing_profiles.
--
-- Agent Marketing is user-centric (expertise and services), NOT a property-sale ad, so none of these tables has a
-- listing, address, price or MLS column. Source-photo provenance is kept in agent_marketing_assets.

-- 1. Marketing Profile: optional real full-body photo of the agent (authentic photo only, never AI-altered).
alter table public.marketing_profiles add column if not exists fullbody_key text;

-- 2. Projects: one row per Agent Marketing piece while it is being built.
create table if not exists public.agent_marketing_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  template text not null check (template in (
    'meet_your_agent','why_list_with_me','your_buyer_advantage','new_construction_specialist',
    'active_adult_55_specialist','my_proven_process','agent_review_highlights','local_market_insider')),
  angle text,
  formats text[] not null default array['9x16','16x9'],
  duration_sec integer not null default 45 check (duration_sec in (30,45,60)),
  voice text not null default 'ssp_male' check (voice in ('ssp_male','ssp_female','custom')),
  intake jsonb not null default '{}'::jsonb,
  narrative jsonb,                       -- latest Claude plan (tagged narration, caption text, scenes, photo shopping list)
  narrative_approved jsonb,              -- frozen copy of what the agent approved; later drafts never overwrite it
  narrative_approved_at timestamptz,
  storyboard jsonb,
  status text not null default 'draft' check (status in (
    'draft','narrative_ready','narrative_approved','images','ready_to_render','rendering','rendered','published','failed')),
  gate_version text,
  gate_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_marketing_projects_user on public.agent_marketing_projects (user_id, created_at desc);
alter table public.agent_marketing_projects enable row level security;

-- 3. Assets: one row per scene image version, with full provenance.
create table if not exists public.agent_marketing_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.agent_marketing_projects(id) on delete cascade,
  user_id uuid not null references public.users(id),
  scene_index integer not null,
  version integer not null default 1,
  source text not null check (source in ('gallery','staged','upload','gpt_image_2')),
  staged_image_id uuid,                  -- staged_images.id when the photo came from a virtually staged Final
  external_photo_id uuid,                -- external_photos.id when it came from an original/external photo
  source_listing_id uuid,                -- provenance only; never shown as an advertised subject
  original_url text,                     -- link back to the original photo is always kept
  staged_url text,
  asset_key text,                        -- S3 key of the image used in the render (clean copy or generated image)
  ai_generated boolean not null default false,
  generation jsonb,                      -- GPT Image 2: prompt, model, number of API requests, charge
  rights jsonb,                          -- uploads: owner, source, usage attestation
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_marketing_assets_project on public.agent_marketing_assets (project_id, scene_index, version);
alter table public.agent_marketing_assets enable row level security;

-- 4. Advertising record: written when a piece is finalized. This is the durable General Advertising Library entry.
create table if not exists public.agent_marketing_ads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.agent_marketing_projects(id),
  user_id uuid not null references public.users(id),
  job_id text,                           -- reel_jobs.id used for allotment / charge-at-download
  title text,
  template text not null,
  market text,
  formats text[] not null,
  duration_sec integer,
  narration_voice text,
  narration_script_tagged text,
  caption_text text,
  cta_text text,
  cta_source text check (cta_source in ('template_default','claude','user_edited','user_inserted')),
  media jsonb,                           -- per-scene summary: source, original/staged links, source listing, ai_generated
  agent_supplied_claims jsonb,           -- outcome claims the agent typed themselves (covered by the attestation)
  attestation_text_version text,
  attested_at timestamptz,
  attested_by uuid references public.users(id),
  gate_version text,
  gate_result jsonb,
  final_9x16_key text,
  final_16x9_key text,
  public_slug text unique,
  public_url text,
  record_txt_key text,
  charged_via text check (charged_via in ('allotment','image')),
  images_charged integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_marketing_ads_user on public.agent_marketing_ads (user_id, created_at desc);
alter table public.agent_marketing_ads enable row level security;

-- 5. Billing reuse: Agent Marketing renders are reel_jobs rows (listing_id stays NULL), so the Reel allotment,
-- charge-at-download and 5-undownloaded counter work unchanged. Existing rows and inserts get kind = 'listing'.
alter table public.reel_jobs add column if not exists project_id uuid references public.agent_marketing_projects(id) on delete set null;
alter table public.reel_jobs add column if not exists kind text not null default 'listing';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reel_jobs_kind_check') then
    alter table public.reel_jobs add constraint reel_jobs_kind_check check (kind in ('listing','agent_marketing'));
  end if;
end $$;
