// agent-appearance-background.js — Netlify Background Function. One headshot enhancement (Nov 27, 2026).
// Dispatched only by agent-appearance.js (shared internal key). The call takes one iteration from the pool, runs, stores the image privately,
// and gives the iteration back if anything fails. The page watches the state, so this returns nothing useful.
const am = require("./lib/agent-marketing-lib");
const R = require("./lib/agent-appearance-headshot-run-lib");
const SR = require("./lib/agent-appearance-stage-run-lib");
const fal = require("./lib/agent-appearance-fal-lib");

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  // Development deploys only: the page starts this job with the subscriber's own login token (see self-dispatch-lib pageDispatch).
  let pageUser = null;
  if (!key || h["x-internal-key"] !== key) {
    pageUser = await require("./lib/self-dispatch-lib").pageDispatchUser(event);
    if (!pageUser) return { statusCode: 401, body: "" };
  }
  try {
    const body = JSON.parse(event.body || "{}");
    const userId = pageUser || body.owner;
    if (!am.UUID_RE.test(String(userId || ""))) return { statusCode: 400, body: "" };
    if (!am.isEnabledFor(userId)) return { statusCode: 404, body: "" };
    if (body.stage) {   // slice 4: one generated image (three-quarter or full-length)
      const r = await SR.runStage({ deps: fal.realDeps(process.env, userId), userId, stage: String(body.stage), note: body.note });
      if (!r.ok) console.error("[agent-appearance] stage did not finish:", r.code);
      return { statusCode: 200, body: "" };
    }
    if (!am.UUID_RE.test(String(body.assetId || ""))) return { statusCode: 400, body: "" };
    const r = await R.runEnhance({ deps: fal.realDeps(process.env, userId), userId, assetId: body.assetId });
    if (!r.ok) console.error("[agent-appearance] enhance did not finish:", r.code);
  } catch (e) { console.error("agent-appearance-background error:", e.message); }
  return { statusCode: 200, body: "" };
};
