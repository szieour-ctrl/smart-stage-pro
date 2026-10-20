-- Listing Reels on the compliance page: record which photos each Reel was built from (Oct 20, 2026).
-- [{ "id": "<photo uuid>", "kind": "staged" | "external" }, ...] in scene order. Additive only.
alter table public.reel_jobs add column if not exists source_photos jsonb;
