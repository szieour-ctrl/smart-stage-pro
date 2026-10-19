-- Records when the user confirmed the advertising-accuracy statement for a Reel render.
-- Smart Stage PRO is the tool; the user is the advertiser. Safe to run any time; reel-render.js works with or without it.
alter table public.reel_jobs add column if not exists advertising_confirmed_at timestamptz;
