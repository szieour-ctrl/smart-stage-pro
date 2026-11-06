// Retired Netlify functions must stay retired: no source file (Netlify deploys any
// top-level file in netlify/functions), no per-function config, and no page or
// function that still calls them.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FUNCTIONS_DIR = path.join(ROOT, "netlify", "functions");

const RETIRED = [
  "generate-narration-background",
  "check-narration",
  "stage-decor8",
  "stage-decor8-background",
  "check-decor8",
  "migrate-listing-media-background",
  "migrate-marketing-media",
  "clean-and-stage-prompt",
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("retired functions have no source file or folder", () => {
  const names = fs.readdirSync(FUNCTIONS_DIR);
  for (const name of RETIRED) {
    for (const candidate of [`${name}.js`, `${name}.mjs`, `${name}.ts`, name]) {
      assert.ok(!names.includes(candidate), `${candidate} must not exist in netlify/functions`);
    }
  }
  const stray = names.filter((n) => /__\d+__/.test(n));
  assert.deepStrictEqual(stray, [], "no versioned leftover copies in netlify/functions");
});

test("netlify.toml has no config for retired functions", () => {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  for (const name of RETIRED) {
    assert.ok(!toml.includes(`[functions."${name}"]`), `netlify.toml still configures ${name}`);
  }
});

test("no page or function calls a retired function", () => {
  const files = walk(ROOT).filter((f) => !f.startsWith(path.join(ROOT, "tests")));
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const name of RETIRED) {
      const callPattern = new RegExp(`functions/${name.replace(/[-]/g, "\\-")}(?![\\w-])|require\\(["'\`]\\./${name}["'\`]\\)`);
      assert.ok(!callPattern.test(src), `${path.relative(ROOT, file)} still references ${name}`);
    }
  }
});
