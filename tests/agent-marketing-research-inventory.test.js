// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const inv = require("../scripts/research-baseline-inventory");

test("inventory: hosts are classed by address, and a host it cannot place is left unclassified for a human", () => {
  const want = {
    "www.lincolnca.gov": "government", "ci.lincoln.ca.us": "government", "freddiemac.gcs-web.com": "financing_economic", "census.gov": "financing_economic",
    "zillow.com": "housing_research", "redfin.com": "housing_research", "car.org": "housing_research", "movoto.com": "portal", "lennar.com": "builder_developer",
    "sacrealtor.org": "association_or_nonprofit", "thegoolsbygroup.com": "brokerage_or_agent", "evatagorerealestate.com": "brokerage_or_agent", "agentkee.com": "brokerage_or_agent",
    "onsiteobserver.com": "news_like", "cahousingmarketnews.com": "news_like", "sacramentoappraisalblog.com": "unclassified", "myfolsom.com": "unclassified", "": "unclassified",
    "sierra.edu": "education",
  };
  for (const [host, cls] of Object.entries(want)) assert.strictEqual(inv.classify(host), cls, host);
});

test("inventory: kept sources only, duplicate uses told apart from unique publishers, and a review sample with the evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  // A fixture run: attempt 1 lost a topic; attempt 2 delivered two topics on two hosts, one host used twice across runs.
  const mkRun = (hostA, hostB) => ({
    schema: 1, used_attempt: 2,
    attempts: [
      { n: 1, sources: [{ topic: 1, host: "dropped.example", outcome: "dropped", stage: "article_eligibility", code: "paywalled" }], topics: [{ topic: 1, outcome: "left_out" }] },
      { n: 2,
        sources: [{ topic: 1, host: hostA, title: "A story", outcome: "kept", provider_date: "2026-10-12", date_from: "provider" }, { topic: 2, host: hostB, title: "B story", outcome: "kept", model_date: "2026-10-01" }],
        topics: [{ topic: 1, outcome: "kept", hook: "Hook one?", final_rank: 1 }, { topic: 2, outcome: "kept", hook: "Hook two?", final_rank: 2 }] },
    ],
    depth: { topics: [{ scope: "selected", trend_signals: 2, newest_source_days: 12 }, { scope: "broader_context", trend_signals: 1, newest_source_days: 30 }] },
  });
  fs.writeFileSync(path.join(dir, "lincoln-as_shipped-1.discovery.json"), JSON.stringify(mkRun("www.lincolnca.gov".replace("www.", ""), "sacrealtor.org")));
  fs.writeFileSync(path.join(dir, "lincoln-r10_c6000-1.discovery.json"), JSON.stringify(mkRun("lincolnca.gov", "thegoolsbygroup.com")));
  fs.writeFileSync(path.join(dir, "thin-as_shipped-1.discovery.json"), JSON.stringify(mkRun("lincolnca.gov", "pplx-LEAKED123456")));
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const runs = inv.readRuns(dir);
  assert.strictEqual(runs.length, 3);
  const r = inv.inventory(runs);
  assert.strictEqual(r.source_uses, 6);                 // dropped sources never count
  assert.strictEqual(r.unique_publishers, 4);           // lincolnca.gov, sacrealtor.org, thegoolsbygroup.com, pplx-...
  assert.strictEqual(r.duplicate_uses, 2);              // lincolnca.gov used three times -> two repeat uses
  assert.strictEqual(r.hosts[0].host, "lincolnca.gov"); assert.strictEqual(r.hosts[0].uses, 3); assert.strictEqual(r.hosts[0].class, "government");
  const lincoln = r.markets.find((m) => m.market === "lincoln");
  assert.deepStrictEqual([lincoln.source_uses, lincoln.unique_publishers, lincoln.duplicate_uses], [4, 3, 1]);
  const md = inv.redact(inv.markdown(r, inv.sample(runs, ["as_shipped"], 1)));
  assert.ok(/## Review sample/.test(md) && /\*\*Hook one\?\*\* \(exact market; 2 signals; newest source 12 days old\)/.test(md));
  assert.ok(/\*\*Hook two\?\*\* \(broader context/.test(md));
  assert.ok(/- lincolnca\.gov \(government\), "A story", date 2026-10-12 \(provider\)/.test(md));
  assert.ok(!md.includes("LEAKED123456"), "key-shaped text is removed from the output");
  assert.throws(() => inv.parseArgs([]), /folder/);
});

test("inventory: works on the folder the baseline harness writes (replay), from the command line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbi-"));
  cp.execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "research-baseline.js"), "--replay", "--markets", "lincoln", "--repeats", "1", "--out", dir], { encoding: "utf8" });
  const out = cp.execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "research-baseline-inventory.js"), dir], { encoding: "utf8" });
  assert.ok(/Runs: 5\. Kept source uses: 25\. Unique publishers: 5\. Repeat uses of a publisher: 20\./.test(out));
  assert.ok(/### lincoln \/ as_shipped \/ run 1/.test(out) && /### lincoln \/ r20_c6000 \/ run 1/.test(out));
});
