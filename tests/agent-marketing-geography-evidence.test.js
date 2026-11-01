// Run with: npm test
// PR 2 (Oct 31 closeout): municipal-domain geographic evidence (publisher jurisdiction kept apart from coverage and relevance), the Colfax skatepark continuation regression,
// and the shadow billing replay (which changes no billing).
const test = require("node:test");
const assert = require("node:assert");
const gh = require("../netlify/functions/lib/agent-marketing-geography-hierarchy-lib");
const ident = require("../netlify/functions/lib/agent-marketing-development-identity-lib");
const cl = require("../netlify/functions/lib/agent-marketing-compact-lib");
const fx = require("./fixtures/research-diag/scenarios");
const SKATE = require("./fixtures/research-diag/colfax-skatepark.json");
const PARK = require("./fixtures/research-diag/parkwood-duplicates.json");

const LINCOLN = { type: "city", name: "Lincoln", city: "", zip: "95648", state: "CA", label: "Lincoln, CA" };
const CROCKER = { type: "neighborhood", name: "Crocker Ranch", city: "Roseville", zip: "95747", state: "CA", label: "Crocker Ranch, Roseville, CA" };
const NATOMAS = { type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95834", state: "CA", label: "Natomas, Sacramento, CA" };
const COLFAX = { type: "city", name: "Colfax", city: "", zip: "95713", state: "CA", label: "Colfax, CA" };
const H = { lincoln: gh.hierarchyFor(LINCOLN), crocker: gh.hierarchyFor(CROCKER), natomas: gh.hierarchyFor(NATOMAS), colfax: gh.hierarchyFor(COLFAX) };
const PJ = (host, h) => gh.publisherJurisdiction(host, h);

test("publisher jurisdiction: recognized official municipal domains for Lincoln, Roseville, Sacramento, Colfax and Placer County; same-named agencies elsewhere and look-alikes never match", () => {
  const ok = [["lincolnca.gov", "lincoln", "market"], ["www.lincolnca.gov", "lincoln", "market"], ["roseville.ca.gov", "crocker", "city"], ["www.roseville.ca.us", "crocker", "city"], ["cityofroseville.gov", "crocker", "city"],
    ["cityofsacramento.gov", "natomas", "city"], ["sacramento.ca.gov", "natomas", "city"], ["colfax-ca.gov", "colfax", "market"], ["placer.ca.gov", "lincoln", "county"], ["saccounty.gov", "natomas", null]];
  for (const [host, m, level] of ok) { const r = PJ(host, H[m]); if (level) assert.deepStrictEqual([r && r.level, r && r.basis], [level, "official_municipal_domain"], host); else assert.strictEqual(r, null, `${host}: a county host this table does not know is not guessed`); }
  for (const [host, m] of [["lincoln.ne.gov", "lincoln"], ["lincolnca.com", "lincoln"], ["lincolnca.gov.example.com", "lincoln"], ["ci.roseville.mn.us", "crocker"], ["roseville.ca.gov", "lincoln"], ["cityofsacramento.gov", "lincoln"], ["lincolnca.org", "lincoln"], ["notlincolnca.gov", "lincoln"], ["crockerranch.ca.gov", "crocker"]]) assert.strictEqual(PJ(host, H[m]), null, host);
});

test("coverage evidence is a name in the title or the address PATH; the publisher's host is not coverage evidence", () => {
  const e = (h, level, src) => gh.nameEvidence(h, level, src);
  assert.strictEqual(e(H.lincoln, "market", { title: "Beermann Plaza Construction", url: "https://lincolnca.gov/news/posts/beermann-plaza-construction/" }).found, false, "lincolnca.gov in the host says who published, not where");
  assert.strictEqual(e(H.lincoln, "market", { title: "Beermann Plaza Construction", url: "https://lincolnca.gov/lincoln/news/beermann" }).found, true, "a name in the path counts");
  assert.strictEqual(e(H.crocker, "city", { title: "Fiddyment Road resurfacing", url: "https://www.roseville.ca.gov/news/fiddyment" }).found, false);
  assert.strictEqual(e(H.crocker, "city", { title: "Roseville awarded $3 million", url: "https://www.roseville.ca.gov/news/fiddyment" }).found, true);
  assert.deepStrictEqual([e(H.lincoln, "market", { title: "x", url: "https://lincoln.ne.gov/News" }).found], [false]);
});

const row = (c) => c;
const src = (over) => ({ title: "Beermann Plaza Construction", url: "https://lincolnca.gov/news/posts/beermann-plaza-construction/", published: "2026-10-27", role: "primary", kind: "government_record", source_geography: "Lincoln, California", reporting_period: "2026-10-27", what_it_establishes: "The city plans construction improvements at Beermann Plaza.", ...(over || {}) });
const cand = (over) => ({ question: "What will Beermann Plaza construction change for downtown Lincoln?", development: "The city plans construction improvements at Beermann Plaza, including a trash enclosure and truck-loading zone.", angle: "Downtown plaza work", why: "Construction could affect nearby businesses and access.", relationship: "market", route: null, strength: "high", relevance: "direct", action_date: "2026-10-27", event: null,
  status: "unverified", status_source: null, status_checked_date: null, status_by_source: [], conflict: null, gap: "Schedule is not stated.", access_confidence: "medium", keyword_match: false, sources: [src()], ...(over || {}) });
const V = (list, geo) => cl.validateCandidates(list, { today: "2026-10-31", geography: geo || LINCOLN });

test("an official municipal domain corroborates the PUBLISHER's jurisdiction only: it does not verify the project's location, earn coverage weight, or establish direct relevance", () => {
  const v = V([cand()]);
  const c = v.topics[0].candidate, g = c.geography;
  assert.deepStrictEqual([g.nameFoundInSource, g.support, g.publisherJurisdiction.level, g.publisherJurisdiction.name, g.boundaryVerified || false], [false, "publisher_jurisdiction_only", "market", "Lincoln", false]);
  assert.strictEqual(c.selection.geoSpecificity, 0, "no ranking credit for the domain");
  assert.strictEqual(c.provisionalEvidence.geography, "publisher_jurisdiction_only_location_unverified");
  assert.ok(c.review.needsReview && /location is not verified/.test(c.review.reasons.join()) && !/unsupported by any source name/.test(c.review.reasons.join()), "flagged as unverified, not as unsupported");
  assert.deepStrictEqual([c.relevance, c.modelRelevance], ["direct", "direct"], "the model's label is kept; the domain neither raises nor creates it");
  // the same candidate whose title names the place carries coverage evidence and ranking weight
  const named = V([cand({ sources: [src({ title: "Lincoln plans Beermann Plaza construction" })] })]).topics[0].candidate;
  assert.deepStrictEqual([named.geography.support, named.selection.geoSpecificity > 0, named.geography.nameFoundInSource], ["name_in_source", true, true]);
  // a candidate on a look-alike domain with no name anywhere is unsupported, not corroborated
  const spoof = V([cand({ sources: [src({ url: "https://lincolnca.com/news/beermann" })] })]).topics[0].candidate;
  assert.deepStrictEqual([spoof.geography.support, spoof.geography.publisherJurisdiction], ["unsupported", null]);
  assert.ok(/unsupported by any source name/.test(spoof.review.reasons.join()));
  // publisher, location and relevance are three separate fields on every candidate
  assert.ok("publisherJurisdiction" in g && "nameFoundInSource" in g && "relevance" in c && c.sources[0].publisherJurisdiction.name === "Lincoln");
});

test("subdivision market: West Roseville and City of Roseville material is accepted as broader context, with the publisher's jurisdiction recorded and no automatic direct relevance", () => {
  const roseville = cand({ question: "Could Roseville's Fiddyment Road resurfacing change the trip home?", development: "Roseville received federal funding to resurface Fiddyment Road.", angle: "Road resurfacing", relationship: "city", route: "The resurfacing is a City of Roseville project on a corridor west Roseville residents use.", relevance: "indirect",
    sources: [src({ title: "Roseville awarded $3 million for Fiddyment Road resurfacing", url: "https://www.roseville.ca.gov/news/fiddyment-road", source_geography: "City of Roseville" })] });
  const west = cand({ question: "Will the west Roseville shopping center appeal change what is built nearby?", development: "Roseville's Sierra View shopping center proposal went back to the Planning Commission.", angle: "Appeal", relationship: "district", route: "The project is in west Roseville; effects on Crocker Ranch are not established.",
    sources: [src({ title: "Proposed west Roseville shopping center faces appeal", url: "https://www.sacbee.com/news/local/roseville-appeal", role: "secondary", kind: "local_news", source_geography: "West Roseville" })] });
  const v = V([roseville, west], CROCKER);
  assert.strictEqual(v.topics.length, 2, "neither is rejected for being broader than the subdivision");
  const byDev = Object.fromEntries(v.topics.map((t) => [t.candidate.geography.relationship, t]));
  assert.deepStrictEqual([byDev.city.scope, byDev.city.candidate.geography.publisherJurisdiction.level, byDev.city.candidate.geography.support], ["broader_context", "city", "name_in_source"]);
  assert.deepStrictEqual([byDev.district.scope, byDev.district.candidate.geography.support, byDev.district.candidate.geography.publisherJurisdiction], ["broader_context", "name_in_source", null]);
  assert.strictEqual(byDev.city.candidate.relevance, "indirect");
});

test("Natomas: the City of Sacramento's domain is the publisher's jurisdiction at the city level, never a verification of a Natomas location", () => {
  const c = V([cand({ development: "Sacramento approved a citywide permit schedule change.", angle: "Permits", relationship: "city", route: "The citywide change applies to Natomas homeowners as city residents.", relevance: "indirect", sources: [src({ title: "City approves permit schedule", url: "https://www.cityofsacramento.gov/news/permits", source_geography: "City of Sacramento" })] })], NATOMAS).topics[0].candidate;
  assert.deepStrictEqual([c.geography.publisherJurisdiction.name, c.geography.publisherJurisdiction.level, c.geography.support], ["City of Sacramento", "city", "publisher_jurisdiction_only"]);
  assert.notStrictEqual(c.geography.boundaryVerified, true);
});

// ── The Colfax skatepark: a described next phase of the same project is not an independent development ──
const done = (c, src1) => ({ ...JSON.parse(JSON.stringify(c)), completed_outcome: { type: "physical", what: "A new public skatepark was built at Parkhill Drive and is open.", source: 1 }, ...(src1 || {}) });
test("regression: the Colfax skatepark opening and its described next phase are one underlying project", () => {
  const a = ident.identityOf({ development: SKATE.opening.development, angle: SKATE.opening.angle, sources: SKATE.opening.sources.map((s) => ({ title: s.title, url: s.url, role: s.role, official: false, whatItEstablishes: s.what_it_establishes })), hierarchyNames: ["Colfax", "Placer County"] });
  const b = ident.identityOf({ development: SKATE.nextPhase.development, angle: SKATE.nextPhase.angle, sources: SKATE.nextPhase.sources.map((s) => ({ title: s.title, url: s.url, role: s.role, official: false, whatItEstablishes: s.what_it_establishes })), hierarchyNames: ["Colfax", "Placer County"] });
  assert.deepStrictEqual([a.continuation, b.continuation, b.independent], [false, true, false]);
  assert.strictEqual(ident.sameIdentity(a, b).basis, "same_project_continuation");
  // through the whole validation: one card, the next phase kept as an alternative angle for Stage B
  const v = cl.validateCandidates([done(SKATE.opening), done(SKATE.nextPhase)], { today: "2026-10-31", geography: COLFAX });
  assert.strictEqual(v.topics.length, 1);
  const c = v.topics[0].candidate;
  assert.ok(/skatepark/i.test(c.development) && !/next phase/.test(c.development));
  assert.strictEqual(c.alternativeAngles.length, 1); assert.strictEqual(c.alternativeAngles[0].duplicateBasis, "same_project_continuation");
  assert.ok(/viewing area/.test(c.alternativeAngles[0].angle + c.alternativeAngles[0].why + SKATE.nextPhase.development) && c.alternativeAngles[0].sources[0].url);
  assert.strictEqual(v.summary.duplicates, 1);
});
test("a phase with its own consequential decision stays a separate card; an unrelated project and distinct Parkwood and Hidden Hills are unaffected", () => {
  // its own identifier and an official primary record: an independent decision
  const phase2 = done(SKATE.nextPhase, { development: "Colfax's Planning Commission approved the skatepark viewing-area phase under permit PLN26-00012.", angle: "Phase approval", question: "Will the approved skatepark viewing area change the neighborhood?",
    status_by_source: [{ source: 1, state: "approved" }],
    sources: [{ title: "Skatepark viewing area approval (PLN26-00012)", url: "https://colfax-ca.gov/planning/pln26-00012", published: "2026-10-20", role: "primary", kind: "government_record", source_geography: "Colfax, CA", reporting_period: "2026-10", what_it_establishes: "The commission approved the viewing-area phase of the skatepark." }] });
  phase2.event = null;
  const v = cl.validateCandidates([done(SKATE.opening), phase2], { today: "2026-10-31", geography: COLFAX });
  assert.strictEqual(v.topics.length, 2, "an independently consequential phase keeps its own card");
  // distinct projects are never merged by the continuation rule
  const hh = { ...PARK.run1[1], development: "The city reviewed production-home designs for Hidden Hills Phase 2 on October 28.", angle: "Design review", question: "What home styles could Hidden Hills Phase 2 bring?", event: null, status_by_source: [], _lane: "housing",
    sources: [{ title: "Hidden Hills Phase 2 designs go to review", url: "https://www.cahousingmarketnews.com/2026/10/hidden-hills-phase-2-designs/", published: "2026-10-31", role: "secondary", kind: "local_news", source_geography: "Lincoln, California", reporting_period: "2026-10-28", what_it_establishes: "The city held a design review for Hidden Hills Phase 2 production homes." }] };
  const pk = cl.validateCandidates([...PARK.run1, hh], { today: "2026-10-31", geography: LINCOLN });
  assert.strictEqual(pk.topics.filter((t) => /Hidden Hills/.test(t.candidate.development)).length, 1);
  assert.strictEqual(pk.topics.filter((t) => /Parkwood/.test(t.candidate.development)).length, 1);
  assert.ok(!ident.sameIdentity(ident.identityOf({ development: "Colfax Measure I proposes a one percent sales tax for streets", sources: [], hierarchyNames: ["Colfax"] }), ident.identityOf({ development: "After the skatepark opening, organizers described a separate next phase: a viewing area", angle: "", sources: [], hierarchyNames: ["Colfax"] })));
});

// ── Shadow billing replay: no billing change ──
test("shadow billing: the floor is replayed from saved sessions (A, B, C variants), reports reasons and provisional dependence, and never touches billing", () => {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const sh = require("../scripts/research-billing-shadow");
  const mk = (rel, relevance, title, url, host) => ({ candidateId: `cand_${Math.random().toString(16).slice(2, 10)}`, lane: "municipal", development: `Development ${title}`, angle: "a", relationship: rel, relevance, strength: "medium", geography: { relationship: rel }, sources: [{ title, url, host, role: "secondary", authority: { official: false }, outletClass: "original_local_reporting" }] });
  const h = gh.hierarchyFor(COLFAX);
  const direct = sh.evaluate(mk("market", "direct", "Colfax hotel renovation", "https://x.example/a", "x.example"), h);
  const pubOnly = sh.evaluate(mk("market", "direct", "Plaza improvements", "https://colfax-ca.gov/news/plaza", "colfax-ca.gov"), h);
  const county = sh.evaluate(mk("county", "direct", "Rocklin homes", "https://x.example/b", "x.example"), h);
  const indirect = sh.evaluate(mk("market", "indirect", "Colfax street tax", "https://x.example/c", "x.example"), h);
  const city = sh.evaluate(mk("city", "direct", "Colfax city note", "https://x.example/d", "x.example"), gh.hierarchyFor(CROCKER));
  assert.deepStrictEqual([direct.A, direct.B, pubOnly.A, pubOnly.B, county.A, indirect.A], [true, true, true, false, false, false]);
  assert.ok(county.why.some((w) => /county-level/.test(w)) && indirect.why.includes("indirect relevance"));
  const j = sh.judge([direct, pubOnly, county, indirect, city].concat([direct, direct].map((d, i) => ({ ...d, identity: { ...d.identity, identifiers: [`z${i}`], projectNames: [`p${i}`], descTokens: [`t${i}longword`] } }))));
  assert.strictEqual(j.floorA, true);
  // the real saved benchmark folder replay (small synthetic folder here): runs, cards, a gap-fill record
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-"));
  const node = (a) => cp.execFileSync(process.execPath, a, { encoding: "utf8" });
  node([path.join(__dirname, "..", "scripts", "research-baseline.js"), "--replay", "--prompt", "gapfill", "--markets", "lincoln,thin", "--repeats", "2", "--out", dir]);
  const out = path.join(dir, "shadow.md"), js = path.join(dir, "shadow.json");
  node([path.join(__dirname, "..", "scripts", "research-billing-shadow.js"), "--in", dir, "--out", out, "--json", js]);
  const md = fs.readFileSync(out, "utf8"), res = JSON.parse(fs.readFileSync(js, "utf8"));
  assert.ok(/Shadow only: no billing, quota or entitlement changes/.test(md) && /## Why sessions with five distinct developments fail the floor/.test(md) && /## Which decisions rest on provisional source geography/.test(md) && /Retained architecture: Municipal \+ Housing, no gap-fill/.test(md));
  assert.strictEqual(res.sessions, 4);
  assert.ok(res.without_gapfill.all.five_distinct <= res.without_gapfill.all.sessions && res.with_gapfill.all.five_distinct >= res.without_gapfill.all.five_distinct);
  assert.ok(!/charged_at|entitlement\s*=|usage\.providerRequests\s*=/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", "research-billing-shadow.js"), "utf8").replace(/\/\/.*$/gm, "")), "the script reads saved records only");
  assert.strictEqual(require("../netlify/functions/lib/agent-marketing-article-led-lib").shouldCharge({ ok: true, topics: new Array(5).fill({}) }), true, "billing rule unchanged: five distinct qualified opportunities");
});
