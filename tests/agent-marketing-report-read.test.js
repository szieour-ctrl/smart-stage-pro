// Reads real files (a generated PDF, a generated .xlsx, CSV text) through the same code the upload endpoint uses.
const test = require("node:test");
const assert = require("node:assert");
const writeXlsx = require("write-excel-file/node").default;
const readLib = require("../netlify/functions/lib/agent-marketing-report-read-lib");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const fx = require("./helpers/cma-fixture");
const { pdfFromPages } = require("./helpers/make-pdf");

test("detectKind goes by the file's first bytes, not its name", () => {
  assert.strictEqual(readLib.detectKind("x.txt", Buffer.from("%PDF-1.7\n...")).kind, "pdf");
  assert.strictEqual(readLib.detectKind("x.csv", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])).kind, "xlsx");
  assert.strictEqual(readLib.detectKind("x.csv", Buffer.from("a,b\n1,2")).kind, "csv");
  assert.strictEqual(readLib.detectKind("old.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])).error, "xls");
  assert.strictEqual(readLib.detectKind("x", Buffer.alloc(0)).error, "empty");
  assert.strictEqual(readLib.detectKind("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).error, "unsupported");
  assert.strictEqual(readLib.detectKind("x.csv", Buffer.alloc(readLib.MAX_BYTES + 1, 65)).error, "too_big");
});

test("parseCsv: quotes, doubled quotes, embedded commas and newlines, tabs, BOM", () => {
  assert.deepStrictEqual(readLib.parseCsv('﻿a,b,c\r\n"x, y","say ""hi""",3\n'), [["a", "b", "c"], ["x, y", 'say "hi"', "3"]]);
  assert.deepStrictEqual(readLib.parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  assert.deepStrictEqual(readLib.parseCsv('a,b\n"line1\nline2",2'), [["a", "b"], ["line1\nline2", "2"]]);
});

test("a real PDF CMA is read end to end and gives the same figures as its text", async () => {
  const f = fx.standard();
  const pdf = await pdfFromPages(f.pages);
  const r = await readLib.readReport(pdf, "My CMA for the Smiths.pdf");
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.kind, "pdf");
  assert.strictEqual(r.facts.sample.total, f.total);
  assert.strictEqual(r.facts.statuses.closed.count, 12);
  assert.strictEqual(r.facts.statuses.closed.medianChecked, true);
  const direct = lib.analyzePages(f.pages).facts;
  assert.deepStrictEqual(r.facts.figures, direct.figures);
  const json = JSON.stringify(r.facts);
  for (const s of ["Smiths", "Pat Fixture", "916-555", "example.com", "Alder", "Birch"]) assert.ok(!json.includes(s), `must not contain ${s}`);
});

test("a real .xlsx export is read, its personal columns ignored and its dates understood", async () => {
  const H = (v) => ({ value: v, fontWeight: "bold" });
  const row = (status, addr, seller, city, list, close, dom, date) => [
    { value: status }, { value: addr }, { value: seller }, { value: city }, { value: list, type: Number }, close == null ? null : { value: close, type: Number }, { value: dom, type: Number }, date ? { value: date, type: Date, format: "mm/dd/yyyy" } : null,
  ];
  const data = [
    [H("Status"), H("Address"), H("Seller Name"), H("City"), H("List Price"), H("Close Price"), H("DOM"), H("Close Date")],
    row("Closed", "5 Hidden Way", "Zed Seller", "Roseville", 610000, 615000, 11, new Date(Date.UTC(2026, 8, 3))),
    row("Closed", "7 Hidden Way", "Yan Seller", "Roseville", 640000, 630000, 22, new Date(Date.UTC(2026, 8, 9))),
    row("Closed", "9 Hidden Way", "Xi Seller", "Roseville", 700000, 705000, 14, new Date(Date.UTC(2026, 8, 21))),
    row("Active", "11 Hidden Way", "Wu Seller", "Roseville", 720000, null, 4, null),
  ];
  const bytes = Buffer.from(await writeXlsx(data).toBuffer());
  const r = await readLib.readReport(bytes, "export.xlsx");
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.kind, "xlsx");
  assert.strictEqual(r.facts.statuses.closed.count, 3);
  assert.strictEqual(r.facts.figures.find((x) => x.status === "closed" && x.key === "median_close_price"), undefined); // three sales: a count only
  assert.deepStrictEqual(r.facts.statuses.closed.dateRange, { start: "2026-09-03", end: "2026-09-21", meaning: "closed" });
  const json = JSON.stringify(r.facts);
  for (const s of ["Hidden", "Seller", "Zed", "Yan"]) assert.ok(!json.includes(s));
});

test("a CSV file is read", async () => {
  const csv = "Status,Address,City,List Price,Sold Price,DOM\nSold,1 Test St,Roseville,600000,610000,10\nSold,2 Test St,Roseville,650000,640000,20\nSold,3 Test St,Roseville,700000,700000,30\n";
  const r = await readLib.readReport(Buffer.from(csv), "x.csv");
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.facts.statuses.closed.count, 3);
  assert.strictEqual(r.facts.figures.find((x) => x.key === "median_close_price"), undefined); // three sales: a count only
  const big = "Status,Address,City,List Price,Sold Price,DOM\n" + Array.from({ length: 10 }, (_, i) => `Sold,${i} Test St,Roseville,${600000 + i * 10000},${600000 + i * 10000},10`).join("\n") + "\n";
  const r10 = await readLib.readReport(Buffer.from(big), "x.csv");
  assert.strictEqual(r10.facts.figures.find((x) => x.key === "median_close_price").value, 645000);
});

test("failures are plain messages, never the file's content or a stack trace", async () => {
  const scan = await pdfFromPages(["x"]);                                    // a PDF with almost no text, like a scan
  const a = await readLib.readReport(scan, "scan.pdf");
  assert.strictEqual(a.ok, false); assert.strictEqual(a.code, "no_text"); assert.match(a.message, /scan/);
  const b = await readLib.readReport(Buffer.from("%PDF-1.4\nthis is not really a pdf at all"), "bad.pdf");
  assert.strictEqual(b.ok, false); assert.strictEqual(b.code, "unreadable"); assert.ok(!/at .*\.js/.test(b.message));
  const c = await readLib.readReport(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]), "broken.xlsx");
  assert.strictEqual(c.ok, false); assert.strictEqual(c.code, "unreadable");
  const d = await readLib.readReport(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "old.xls");
  assert.strictEqual(d.code, "xls"); assert.match(d.message, /xlsx/);
  const e = await readLib.readReport(Buffer.from("Notes\nhello\n"), "notes.csv");
  assert.strictEqual(e.ok, false); assert.strictEqual(e.code, "no_header");
  const f = await readLib.readReport(Buffer.alloc(0), "empty.pdf");
  assert.strictEqual(f.code, "empty");
});
