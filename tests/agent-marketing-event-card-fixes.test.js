"use strict";
// Oct 29, 2026 Eskaton Local Events test: the opening card says when the event is, the closing headline is a complete thought,
// and the planner keeps the page's own wording for who benefits from proceeds.
const test = require("node:test");
const assert = require("node:assert");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

test("eventWhen: weekday, date and time in plain words", () => {
  assert.strictEqual(director.eventWhen({ date: "2026-11-14", time: "10:00 am to 2:00 pm" }), "Saturday, Nov 14 · 10 a.m. to 2 p.m.");
  assert.strictEqual(director.eventWhen({ date: "2026-11-14", time: "10:30 AM - 2 PM" }), "Saturday, Nov 14 · 10:30 a.m. - 2 p.m.");
  assert.strictEqual(director.eventWhen({ date: "2026-11-14", endDate: "2026-11-16", time: "9 a.m. to 5 p.m. daily" }), "Nov 14–16 · 9 a.m. to 5 p.m. daily");
  assert.strictEqual(director.eventWhen({ date: "2026-11-28", endDate: "2026-12-02" }), "Nov 28 – Dec 2");
  assert.strictEqual(director.eventWhen({ date: "bad" }), "");
  assert.strictEqual(director.eventWhen(null), "");
});

test("the opening card of an event Reel shows the event's date and time, a market Reel keeps its eyebrow", () => {
  const narrative = { hook: "There's a craft fair this November.", scenes: [{ role: "hook", narrationExcerpt: "There's a craft fair this November." }, { role: "x", narrationExcerpt: "Vendors and handmade goods." }, { role: "next_step", narrationExcerpt: "Hope you enjoy the fair!" }] };
  const ev = { date: "2026-11-14", time: "10:00 am to 2:00 pm" };
  const e = director.plan(narrative, { market: "Roseville, CA" }, [], { eventReel: true, event: ev }).scenes[0].data;
  assert.strictEqual(e.kind, "Local Events");
  assert.strictEqual(e.eyebrow, "Saturday, Nov 14 · 10 a.m. to 2 p.m.");
  assert.strictEqual(director.plan(narrative, { market: "Roseville, CA" }, [], { eventReel: true }).scenes[0].data.eyebrow, "Happening Locally");
  assert.strictEqual(director.plan(narrative, { market: "Roseville, CA" }, []).scenes[0].data.eyebrow, "Seller Insight");
});

test("the closing headline is never cut off mid-sentence (the Eskaton 'part of what makes' bug)", () => {
  const wc = (t) => (String(t).match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  const c = director.closingHeadline("Events like this are part of what makes Roseville feel like home. I hope you enjoy every minute of it—and check Eskaton Village Roseville's page for the latest details.");
  const h = c.headline.join(" ");
  assert.ok(wc(h) <= 8, h);
  assert.doesNotMatch(h, /what makes$/i);
  assert.match(h, /^I hope you enjoy every minute of it$/i);
  // A sentence that fits whole is still used whole.
  assert.strictEqual(director.closingHeadline("Hope to see you there.").headline.join(" "), "Hope to see you there.");
});

test("the planner keeps the source's wording for proceeds and who benefits", () => {
  assert.match(planLib.buildSystemPrompt(), /never make a statement stronger than the page makes it/);
});
