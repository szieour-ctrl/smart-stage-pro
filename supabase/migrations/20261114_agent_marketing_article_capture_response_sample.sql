-- Nov 14, 2026 (Test/development only): a short, sanitized sample of what a refused article page said (at most 300 characters; scripts, tags, e-mail
-- addresses and token-like strings removed), so a capture that returns a stub can be diagnosed. The table is service-role only (RLS on, no policies).
alter table public.agent_marketing_article_capture_attempts add column if not exists response_sample text;
