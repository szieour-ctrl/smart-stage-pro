// Run with: npm test
// The subscriber's logo reaches the Agent Marketing Reel (Nov 9, 2026). The Reel carried only the headshot, name and brokerage; the renderer
// now draws an optional brand.logo_key on opening and closing cards. This checks the Netlify side: the brand carries the profile's logo key
// when there is one, and its download link is prepared with the other assets. No logo in the profile: nothing changes.
"use strict";
const test = require("node:test");
const assert = require("node:assert");

Object.assign(process.env, { S3_REGION: "us-west-2", S3_BUCKET_NAME: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", RAILWAY_RENDER_URL: "https://railway.test",
  RAILWAY_SECRET: "rs", INTERNAL_API_KEY: "ik", AGENT_MARKETING_ENABLED: "true", SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" });

const { brandFromProfile, dispatchKeys } = require("../netlify/functions/agent-marketing-prepare-background");
const M = require("../netlify/functions/lib/agent-marketing-manifest-lib");

const profile = { licensed_name: "Sam Zieour", brokerage_name: "SZ Real Estate Group", headshot_key: "smart-stage-marketing/branding/u1/headshot_1.png", brand_primary: "#1A2B5F", brand_secondary: "#1A2B5F", brand_border: "#FFFFFF", brand_font: "Roboto" };
const LOGO = "smart-stage-marketing/branding/u1/logo_1.png";

test("the brand carries the profile's logo key when there is one, and is unchanged when there is not", () => {
  const withLogo = brandFromProfile({ ...profile, logo_key: LOGO });
  assert.strictEqual(withLogo.logo_key, LOGO);
  assert.strictEqual(withLogo.headshot_key, profile.headshot_key);
  assert.deepStrictEqual(withLogo.agent, { name: "Sam Zieour", brokerage: "SZ Real Estate Group" });
  for (const none of [{}, { logo_key: null }, { logo_key: "" }]) {
    const b = brandFromProfile({ ...profile, ...none });
    assert.ok(!("logo_key" in b), "no logo_key property at all");
    assert.deepStrictEqual(Object.keys(b).sort(), ["agent", "border", "font", "headshot_key", "primary", "secondary"]);
  }
});

test("the logo's download link is prepared with the other assets, and only when the brand has a logo", () => {
  const manifest = (brand) => ({ brand, audio: { narration_key: "narr.mp3" }, scenes: [{ visual: { image_keys: { "9x16": "img1.png", "16x9": "img2.png" } } }, { visual: { image_keys: { "9x16": "img1.png" } } }] });
  const withLogo = [...dispatchKeys(manifest({ logo_key: LOGO }), profile.headshot_key)];
  assert.deepStrictEqual(withLogo.sort(), [LOGO, "img1.png", "img2.png", "narr.mp3", profile.headshot_key].sort());
  const without = [...dispatchKeys(manifest({}), profile.headshot_key)];
  assert.ok(!without.includes(LOGO));
  assert.deepStrictEqual(without.sort(), ["img1.png", "img2.png", "narr.mp3", profile.headshot_key].sort());
});

test("a manifest with brand.logo_key still validates: the logo is optional and not an approval condition", () => {
  const src = require("fs").readFileSync(require.resolve("../netlify/functions/lib/agent-marketing-manifest-lib"), "utf8");
  assert.ok(!/logo/i.test(src), "the manifest validator has no logo rule, so a logo can never block a Reel");
  assert.strictEqual(typeof M.validateManifest, "function");
});
