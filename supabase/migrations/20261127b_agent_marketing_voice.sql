-- Agent Marketing: the subscriber's own ElevenLabs voice (slice 3, Nov 27, 2026). ADDITIVE: one new table; nothing existing is touched.
-- RLS is on with NO policies: service role only. The API key is stored ENCRYPTED (AES-256-GCM) and is never returned to the browser.
create table if not exists public.agent_marketing_voices (
  user_id uuid primary key references public.users(id),
  voice_id text not null,
  key_enc text not null,                 -- v1.iv.tag.ciphertext (base64url); see agent-marketing-voice-lib
  key_last4 text,                        -- shown back to the subscriber so they can tell which key is saved
  consent_version text not null,
  consent_at timestamptz not null default now(),
  tested_at timestamptz,
  test_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.agent_marketing_voices enable row level security;
