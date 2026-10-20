-- Listing Reels on the property compliance page (Oct 20, 2026). Additive only; run in the Supabase SQL editor.
-- reel-download.js copies a downloaded Reel from smart-stage-reel-drafts/ (7-day) to smart-stage-reel-finals/
-- (permanent) and records the keys here; compliance-page.js shows Reels that have final_branded_key set.
alter table public.reel_jobs
  add column if not exists final_branded_key text,
  add column if not exists final_unbranded_key text,
  add column if not exists finalized_at timestamptz;
create index if not exists idx_reel_jobs_listing_final on public.reel_jobs (listing_id) where final_branded_key is not null;
