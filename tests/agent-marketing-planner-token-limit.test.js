"use strict";
// The development Article-Led planner gets a larger reply allowance (it was cut off at 4,000 tokens); every other caller keeps the default.
const test = require("node:test");
const assert = require("node:assert");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");

function seen(project, flag) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (flag) process.env.AGENT_MARKETING_B1_EVIDENCE = flag; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  const opts = [];
  const callFn = async (_s, _u, _k, _sink, o) => { opts.push(o); throw new Error("stop here"); };
  return plan.generatePlan({ project, anthropicKey: "k", callFn }).catch(() => {}).then(() => {
    if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev;
    return opts;
  });
}

test("planner token limit: dev Article-Led gets 6000, everything else the default", async () => {
  const base = { template: "other", duration_sec: 45, selected_topic: { title: "t" } };
  const web = await seen(base, "dev");
  assert.strictEqual(web[0], undefined, "no b1Evidence: default limit");
  const prod = await seen({ ...base, selected_topic: { title: "t", b1Evidence: {} } }, null);
  assert.strictEqual(prod[0], undefined, "flag off: default limit");
  const realAssert = b1.assertNotBlocked; b1.assertNotBlocked = () => null; // the evidence bundle itself is not under test here
  let dev;
  try { dev = await seen({ ...base, template: "local_market_insider", selected_topic: { title: "t", b1Evidence: {} } }, "dev"); } finally { b1.assertNotBlocked = realAssert; }
  assert.deepStrictEqual(dev[0], { maxTokens: 6000 }, "dev Article-Led: larger limit");
});
