-- Market Update mode chosen on the project (Nov 8, 2026). Applied to the development database only; Production unchanged.
--   trend_report       1. Market Trend Update: topics and script from the uploaded Trend/CMA report only (research data_source "upload").
--   article_report     2. Article-Led Market Update + Trend/CMA: the article is the subject; the report supplies every local market statistic ("both").
--   article_editorial  3. Article-Led Market Update, Realtor editorial perspective, no report ("web").
-- Null on existing rows: the page asks the agent to choose; nothing is inferred for old projects.
alter table public.agent_marketing_projects add column if not exists market_update_mode text
  check (market_update_mode is null or market_update_mode in ('trend_report', 'article_report', 'article_editorial'));
