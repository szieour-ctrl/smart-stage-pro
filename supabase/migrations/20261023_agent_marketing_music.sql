-- Agent Marketing: music choice made in Setup (Oct 23, 2026). Already applied to production.
-- Keys match MUSIC_LIBRARY in build-video-demo.html (the Railway renderer's music library).
alter table public.agent_marketing_projects add column if not exists music text not null default 'default';
