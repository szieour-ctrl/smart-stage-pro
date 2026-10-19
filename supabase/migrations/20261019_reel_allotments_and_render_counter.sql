-- Reel allotments + not-downloaded render counter (Oct 19, 2026). Additive only.
-- Already applied to project dnpaenpwdhjmslymgkse via the Supabase MCP; kept here for review.
-- Rules live in netlify/functions/lib/reel-quota-lib.js. All functions are service_role only.

alter table public.video_quota_usage
  add column if not exists reels_downloaded integer not null default 0;

create table if not exists public.reel_jobs (
  id text primary key,
  user_id uuid not null references public.users(id),
  listing_id uuid references public.listings(id),
  status text not null default 'running' check (status in ('running','complete','failed')),
  event text,
  length_sec integer,
  branded_key text,
  unbranded_key text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  counted_at timestamptz,
  downloaded_at timestamptz,
  charged_via text check (charged_via in ('allotment','image')),
  images_charged integer not null default 0
);
create index if not exists idx_reel_jobs_user_created on public.reel_jobs (user_id, created_at desc);
alter table public.reel_jobs enable row level security;

create table if not exists public.reel_render_counter (
  user_id uuid primary key references public.users(id),
  undownloaded integer not null default 0 check (undownloaded >= 0),
  owed_images integer not null default 0 check (owed_images >= 0),
  updated_at timestamptz not null default now()
);
alter table public.reel_render_counter enable row level security;

-- Count one completed render (idempotent per job). Every 5th undownloaded render
-- resets the counter to 0 and reports waste=true so the caller charges 1 Image.
create or replace function public.reel_count_completion(p_job_id text, p_branded text default null, p_unbranded text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.reel_jobs; c public.reel_render_counter; new_n integer; waste boolean := false;
begin
  select * into j from public.reel_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('counted', false, 'reason', 'no_job'); end if;
  if j.status = 'failed' then return jsonb_build_object('counted', false, 'reason', 'failed', 'user_id', j.user_id); end if;
  if j.counted_at is not null then
    return jsonb_build_object('counted', false, 'reason', 'already', 'user_id', j.user_id);
  end if;
  update public.reel_jobs
     set status = 'complete', completed_at = coalesce(completed_at, now()), counted_at = now(),
         branded_key = coalesce(p_branded, branded_key), unbranded_key = coalesce(p_unbranded, unbranded_key)
   where id = p_job_id;
  insert into public.reel_render_counter(user_id) values (j.user_id) on conflict (user_id) do nothing;
  select * into c from public.reel_render_counter where user_id = j.user_id for update;
  new_n := c.undownloaded + 1;
  if new_n >= 5 then new_n := 0; waste := true; end if;
  update public.reel_render_counter set undownloaded = new_n, updated_at = now() where user_id = j.user_id;
  return jsonb_build_object('counted', true, 'waste', waste, 'undownloaded', new_n, 'user_id', j.user_id);
end $$;

-- Mark a render failed (never counted).
create or replace function public.reel_mark_failed(p_job_id text)
returns void language sql security definer set search_path = public as $$
  update public.reel_jobs set status = 'failed' where id = p_job_id and counted_at is null;
$$;

-- Atomic download decision. Included Reel if reels_downloaded < p_limit for the period, else 1 Image.
-- Any download resets the not-downloaded counter to 0.
create or replace function public.reel_consume_download(p_job_id text, p_user_id uuid, p_period date, p_limit integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.reel_jobs; used integer; prev integer := 0; via text; imgs integer;
begin
  select * into j from public.reel_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('error', 'job_not_found'); end if;
  if j.user_id <> p_user_id then return jsonb_build_object('error', 'forbidden'); end if;
  if j.status <> 'complete' then return jsonb_build_object('error', 'not_ready'); end if;
  if j.downloaded_at is not null then
    return jsonb_build_object('already', true, 'branded_key', j.branded_key, 'unbranded_key', j.unbranded_key);
  end if;
  insert into public.video_quota_usage(user_id, period_start) values (p_user_id, p_period)
    on conflict (user_id, period_start) do nothing;
  select reels_downloaded into used from public.video_quota_usage
   where user_id = p_user_id and period_start = p_period for update;
  insert into public.reel_render_counter(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select undownloaded into prev from public.reel_render_counter where user_id = p_user_id for update;
  if used < p_limit then
    update public.video_quota_usage set reels_downloaded = used + 1, updated_at = now()
     where user_id = p_user_id and period_start = p_period;
    via := 'allotment'; imgs := 0;
  else
    via := 'image'; imgs := 1;
  end if;
  update public.reel_jobs set downloaded_at = now(), charged_via = via, images_charged = imgs where id = p_job_id;
  update public.reel_render_counter set undownloaded = 0, updated_at = now() where user_id = p_user_id;
  return jsonb_build_object('via', via, 'images', imgs, 'prev_undownloaded', prev, 'used_before', used,
                            'branded_key', j.branded_key, 'unbranded_key', j.unbranded_key);
end $$;

-- Undo an Image-path download whose debit failed (insufficient credits).
create or replace function public.reel_revert_download(p_job_id text, p_user_id uuid, p_prev integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.reel_jobs set downloaded_at = null, charged_via = null, images_charged = 0
   where id = p_job_id and user_id = p_user_id and charged_via = 'image';
  if found then
    update public.reel_render_counter set undownloaded = greatest(undownloaded, p_prev), updated_at = now()
     where user_id = p_user_id;
  end if;
end $$;

-- Unpaid waste fees (debit failed at the 5th render): +1 now, -1 when settled at the next render.
create or replace function public.reel_owed_adjust(p_user_id uuid, p_delta integer)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.reel_render_counter(user_id) values (p_user_id) on conflict (user_id) do nothing;
  update public.reel_render_counter set owed_images = greatest(0, owed_images + p_delta), updated_at = now()
   where user_id = p_user_id returning owed_images into n;
  return n;
end $$;

revoke all on function public.reel_count_completion(text, text, text) from public, anon, authenticated;
revoke all on function public.reel_mark_failed(text) from public, anon, authenticated;
revoke all on function public.reel_consume_download(text, uuid, date, integer) from public, anon, authenticated;
revoke all on function public.reel_revert_download(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.reel_owed_adjust(uuid, integer) from public, anon, authenticated;
grant execute on function public.reel_count_completion(text, text, text) to service_role;
grant execute on function public.reel_mark_failed(text) to service_role;
grant execute on function public.reel_consume_download(text, uuid, date, integer) to service_role;
grant execute on function public.reel_revert_download(text, uuid, integer) to service_role;
grant execute on function public.reel_owed_adjust(uuid, integer) to service_role;
