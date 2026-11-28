-- Agent Appearance Sheet, slice 4 (Nov 27, 2026): the subscriber's optional instruction for a retry is kept on the call row (audit). ADDITIVE.
alter table public.agent_appearance_calls add column if not exists note text;
