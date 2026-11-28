-- Agent Appearance Sheet, slice 4 (Nov 27, 2026): the subscriber's optional instruction for a retry is kept on the call row (audit). ADDITIVE.
alter table public.agent_appearance_calls add column if not exists note text;
-- The subscriber's own words for what they wear from the waist down (asked at the three-quarter step) and for their shoes (asked at the full-length step).
alter table public.agent_appearance_sheets add column if not exists lower_body text;
alter table public.agent_appearance_sheets add column if not exists shoes text;
