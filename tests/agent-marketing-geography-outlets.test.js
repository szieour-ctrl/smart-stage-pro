// Run with: npm test
// PR 2, compact Stage A: the geographic hierarchy and the deterministic outlet registry.
const test = require("node:test");
const assert = require("node:assert");
const gh = require("../netlify/functions/lib/agent-marketing-geography-hierarchy-lib");
const outlets = require("../netlify/functions/lib/agent-marketing-outlet-registry-lib");

const CROCKER = { type: "neighborhood", name: "Crocker Ranch", city: "Roseville", zip: "95747", state: "CA" };
const chain = (g) => gh.hierarchyFor(g).levels.map((l) => `${l.level}:${l.name}`);

test("Crocker Ranch sits in West Roseville, ZIP 95747, the City of Roseville and Placer County, as separate levels", () => {
  assert.deepStrictEqual(chain(CROCKER), ["market:Crocker Ranch", "district:West Roseville", "zip:ZIP 95747", "city:City of Roseville", "county:Placer County"]);
  const h = gh.hierarchyFor(CROCKER);
  assert.strictEqual(h.derived, false);
  assert.ok(/not assumed to share boundaries/.test(h.note) && /not assume two levels share boundaries/.test(gh.hierarchyLine(h)));
  assert.ok(/Crocker Ranch.*selected market.*subdivision.*West Roseville.*ZIP 95747.*City of Roseville.*Placer County/.test(gh.hierarchyLine(h)));
});

test("the other benchmark markets, a ZIP market and an unknown neighborhood", () => {
  assert.deepStrictEqual(chain({ type: "city", name: "Lincoln", zip: "95648" }), ["market:Lincoln", "zip:ZIP 95648", "county:Placer County"]);
  assert.deepStrictEqual(chain({ type: "city", name: "Colfax", zip: "95713" }), ["market:Colfax", "zip:ZIP 95713", "county:Placer County"]);
  assert.deepStrictEqual(chain({ type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95834" }), ["market:Natomas", "zip:ZIP 95834", "city:City of Sacramento", "county:Sacramento County"]);
  assert.deepStrictEqual(chain({ type: "zip", name: "95678" }), ["market:ZIP 95678"]);
  const u = gh.hierarchyFor({ type: "neighborhood", name: "Whitney Ranch", city: "Rocklin", zip: "95765" });
  assert.deepStrictEqual([u.derived, u.levels.map((l) => l.level)], [true, ["market", "zip", "city", "county"]]);
  assert.ok(/^Derived from the request/.test(u.note));
  assert.strictEqual(gh.hierarchyFor({ type: "neighborhood", name: "Nowhere Estates", city: "Faraway" }).levels.some((l) => l.level === "county"), false, "no county is invented");
});

test("relationship vocabulary: only these eight; for a city market the city is the market itself", () => {
  assert.deepStrictEqual(gh.LEVELS, ["market", "district", "zip", "city", "county", "region", "state", "national"]);
  const city = gh.hierarchyFor({ type: "city", name: "Lincoln" }), hood = gh.hierarchyFor(CROCKER);
  assert.strictEqual(gh.normalizeRelationship("city", city), "market");
  assert.strictEqual(gh.normalizeRelationship("city", hood), "city");
  assert.strictEqual(gh.normalizeRelationship(" District ", hood), "district");
  assert.strictEqual(gh.normalizeRelationship("exact_market", hood), null);
  assert.strictEqual(gh.normalizeRelationship("same_jurisdiction", hood), null);
});

test("name evidence shows a name appears in the title, address or host, never that a boundary was verified; wider names do not stand in for the market", () => {
  const h = gh.hierarchyFor(CROCKER);
  const find = (level, s) => gh.nameEvidence(h, level, s);
  let e = find("market", { title: "Crocker Ranch Phase 4 tentative map", url: "https://roseville.ca.us/x" });
  assert.deepStrictEqual([e.found, e.where, e.boundaryVerified], [true, "title", false]);
  e = find("market", { title: "Roseville planning commission agenda", url: "https://www.roseville.ca.us/planning/agenda" });
  assert.strictEqual(e.found, false, "the city's name does not support a market-level claim");
  e = find("market", { title: "Agenda", url: "https://example.org/crocker-ranch/phase-4" });
  assert.deepStrictEqual([e.found, e.where], [true, "url"]);
  e = find("city", { title: "Roseville market update", url: "https://x.example/a" });
  assert.strictEqual(e.found, true);
  e = find("zip", { title: "Roseville, CA 95747 housing market", url: "https://x.example/a" });
  assert.strictEqual(e.found, true);
  e = find("zip", { title: "Roseville market update", url: "https://x.example/a" });
  assert.strictEqual(e.found, false, "the ZIP level needs the ZIP");
  e = find("district", { title: "West Roseville growth plan", url: "https://x.example/a" });
  assert.strictEqual(e.found, true);
  assert.strictEqual(find("county", { title: "Placer County permits", url: "https://x.example" }).found, true);
  assert.strictEqual(find("state", { title: "California sales", url: "https://x.example" }).reason, "not_checked");
  assert.strictEqual(find("market", { title: "Crocker", url: "https://x.example/crockery" }).found, false, "whole names only");
  assert.ok(gh.SPECIFICITY.market > gh.SPECIFICITY.city && gh.SPECIFICITY.city > gh.SPECIFICITY.county);
});

test("outlet registry: original local reporting, trade aggregation, brokerage commentary, syndication, government and housing research are told apart in code", () => {
  const c = (h) => outlets.classifyOutlet(h).class;
  assert.deepStrictEqual(["kcra.com", "www.nsarrow.com", "sacbee.com", "goldmountaincanews.com"].map(c), Array(4).fill("original_local_reporting"));
  assert.deepStrictEqual(["cahousingmarketnews.com", "news.theregistrysf.com", "hoodline.com"].map(c), Array(3).fill("trade_aggregation"));
  assert.deepStrictEqual(["thegoolsbygroup.com", "agentkee.com", "richandkatsoldthat.com"].map(c), Array(3).fill("brokerage_or_agent_commentary"));
  assert.deepStrictEqual(["morningstar.com", "finance.yahoo.com", "prnewswire.com"].map(c), Array(3).fill("syndicated_release"));
  assert.deepStrictEqual(["ceqanet.lci.ca.gov", "colfax-ca.gov", "roseville.ca.us", "www.lincolnca.gov"].map((h) => (h === "colfax-ca.gov" ? "government_record" : c(h))), Array(4).fill("government_record"));
  assert.strictEqual(c("freddiemac.com"), "official_financing");
  assert.deepStrictEqual(["cbre.com", "zillow.com", "redfin.com"].map(c), Array(3).fill("housing_research"));
  assert.deepStrictEqual(["car.org", "sacrealtor.org", "natomaschamber.org"].map(c), Array(3).fill("association"));
  assert.strictEqual(c("lennar.com"), "builder_developer");
});

test("outlet registry: reliability is stated, unknown hosts stay unclassified for review, and nothing is banned", () => {
  assert.deepStrictEqual(outlets.classifyOutlet("kcra.com"), { class: "original_local_reporting", basis: "registry", host: "kcra.com" });
  assert.strictEqual(outlets.classifyOutlet("ceqanet.lci.ca.gov").basis, "official_host");
  assert.deepStrictEqual(outlets.classifyOutlet("smithrealty.com").basis, "pattern");     // a brokerage-looking name: lower confidence, labelled as a pattern
  for (const h of ["houseberry.com", "onsiteobserver.com", "colfax-ca.example", "", "not a host"]) assert.strictEqual(outlets.classifyOutlet(h).class === "unclassified" || outlets.classifyOutlet(h).basis !== "registry", true, h);
  assert.deepStrictEqual(outlets.classifyOutlet("houseberry.com"), { class: "unclassified", basis: "none", host: "houseberry.com" });
  assert.ok(outlets.CLASSES.includes("brokerage_or_agent_commentary") && !("banned" in outlets));
  assert.strictEqual(outlets.isOriginalLocalReporting(outlets.classifyOutlet("kcra.com")), true);
  assert.strictEqual(outlets.isOriginalLocalReporting(outlets.classifyOutlet("cahousingmarketnews.com")), false);
});

test("Natomas sub-areas and named developments are recognized without being treated as ZIP 95834; a missing hierarchy level is provisional, not a rejection", () => {
  const NAT = { type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95834", state: "CA" };
  const h = gh.hierarchyFor(NAT);
  assert.ok(h.subareas.includes("North Natomas") && h.subareas.includes("South Natomas") && h.subareas.includes("ParkBridge"));
  assert.ok(/not equivalent to the ZIP code/.test(gh.hierarchyLine(h)));
  // "district" is not a level for Natomas: the market name or a known sub-area is looked for instead, and the result is provisional
  const topgolf = gh.nameEvidence(h, "district", { title: "South Natomas Topgolf plan stalls", url: "https://www.nsarrow.com/topgolf" });
  assert.deepStrictEqual([topgolf.found, topgolf.via, topgolf.provisional, topgolf.boundaryVerified], [true, "market_name", true, false]);
  const parkbridge = gh.nameEvidence(h, "market", { title: "Public Comment Open: Village 5 ParkBridge Homes (DR26-197)", url: "https://natomaschamber.org/comment" });
  assert.deepStrictEqual([parkbridge.found, parkbridge.via, parkbridge.names], [true, "subarea", ["ParkBridge"]]);
  const none = gh.nameEvidence(h, "district", { title: "A new development opens", url: "https://example.com/story" });
  assert.deepStrictEqual([none.found, none.reason], [false, "name_not_found"]);
  assert.strictEqual(gh.normalizeRelationship("district", h), "district", "not rejected for a missing level");
  // levels the market does have are unchanged: a ZIP claim still needs the ZIP
  assert.strictEqual(gh.nameEvidence(h, "zip", { title: "North Natomas homes", url: "https://x.example/a" }).found, false);
});

test("publisher registry additions: syndicated and aggregated material gets no original-reporting credit; CBS counts only on its Sacramento newsroom paths; unknown hosts stay usable", () => {
  const c = (u) => outlets.classifyOutlet(u).class;
  assert.strictEqual(c("https://sacramentoappraisalblog.com/post"), "professional_commentary");
  assert.strictEqual(c("https://whatnow.com/sacramento/restaurants/x"), "local_business_news");
  assert.strictEqual(c("https://www.yahoo.com/news/x"), "syndicated_release");
  assert.strictEqual(c("https://www.resideline.com/zip/95747"), "portal");
  assert.strictEqual(c("https://www.cbsnews.com/sacramento/news/x"), "original_local_reporting");
  assert.strictEqual(c("https://www.cbsnews.com/news/x"), "syndicated_release");
  assert.strictEqual(c("https://www.onsiteobserver.com/x"), "unclassified");
  for (const u of ["https://sacramentoappraisalblog.com/post", "https://whatnow.com/a", "https://www.yahoo.com/news/x", "https://cahousingmarketnews.com/x", "https://hoodline.com/x"]) assert.strictEqual(outlets.isOriginalLocalReporting(outlets.classifyOutlet(u)), false, u);
});
