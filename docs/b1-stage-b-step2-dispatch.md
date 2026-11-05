# Background dispatch stays on its own deploy (Stage B step 2, Nov 5, 2026)

`lib/self-dispatch-lib.js` `selfBase(event, legacy)` decides where a function sends its own background job:
- **Production host, or no request host:** it returns `legacy`, the call site's existing expression, unchanged. Production routing is identical.
- **Any other host** (Deploy Preview, branch deploy, unique deploy URL, local `netlify dev`): it returns the deploy that received the request.
  It never uses `URL`, `SITE_URL`, `NETLIFY_URL` or a hardcoded production fallback. A malformed host throws instead of falling back.

Used by every background dispatcher:
- `agent-marketing-images`, `agent-marketing-project`, `agent-marketing-render`, `agent-marketing-research`
- `group-spatial-read`, `reel-plan`, `stage-openai`, `clean-and-stage-prompt`, `video-job` (auto-select)
- `agent-marketing-stageb`

`declutter-prompt` already used the request host. Stage B additionally refuses to dispatch from a production host at all
(`503 production_dispatch_refused`).

Tests: `tests/b1-production-isolation.test.js`. It covers:
- production equivalence;
- non-production hosts;
- a repository scan proving every dispatcher uses `selfBase`;
- Stage B with `fetch` stubbed;
- fail-closed configuration.
