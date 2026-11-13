"use strict";
// Script-writing calls get a 6,000-token reply ceiling (4,000 cut longer replies off) on every path; other callers keep their own limits.
const test = require("node:test");
const assert = require("node:assert");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");

test("planner token limit: generatePlan asks for 6000 on every path", async () => {
  for (const template of ["other", "local_market_insider"]) {
    const opts = [];
    const callFn = async (_s, _u, _k, _sink, o) => { opts.push(o); throw new Error("stop here"); };
    await plan.generatePlan({ project: { template, duration_sec: 45, selected_topic: { title: "t" } }, anthropicKey: "k", callFn }).catch(() => {});
    assert.deepStrictEqual(opts[0], { maxTokens: 6000 }, template);
  }
});

test("a narration longer than its Reel stops the development job before any image is made", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../netlify/functions/agent-marketing-prepare-background.js"), "utf8");
  const guard = src.indexOf("over the ${project.duration_sec}-second limit");
  assert.ok(guard > 0, "guard present");
  assert.ok(guard < src.indexOf("await put(key, audio"), "checked before the narration is stored");
  assert.match(src, /AGENT_MARKETING_B1_EVIDENCE[^\n]*\|\| ""\)\.trim\(\)\.toLowerCase\(\) === "dev" && project\.duration_sec/);
});
