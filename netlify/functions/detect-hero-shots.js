// detect-hero-shots.js — Netlify Function
// Call 2 of the Cinematic Asset Generator workflow. Reads the APPROVED staged
// image and returns structured hero-shot suggestions, each grounded in one of
// the 12 fixed Photographer-Direction rules (Smart Stage PRO Hero Shot
// Photographer-Direction Rules v1) rather than freeform camera description.
//
// v2 fixes (per Sam's 1st-iteration review):
// - Vision focus was clustering bboxes toward the ceiling/upper frame, where
//   there's little to extract. Explicit instruction added: bias toward the
//   foreground/floor-level two-thirds of the frame, where furniture, fixtures,
//   and staged assets actually are.
// - Added the 12-rule catalog so each suggested shot carries a specific
//   camera_technique (angle, lens_feel, composition, depth_of_field, lighting,
//   aspect ratio), render_direction, and disallow list — not generic style
//   words, and not just a bbox.
//
// FLAG FOR SAM: env var name (ANTHROPIC_API_KEY) and model string
// (claude-haiku-4-5-20251001) are still inferred, not confirmed against your
// existing Haiku spatial-read function.

const https = require("https");

// Condensed from Smart Stage PRO™ Hero Shot Photographer-Direction Rules v1.
// Full purpose/eligibility prose trimmed to what Claude needs to SELECT a rule
// and populate camera_technique — this is reference data for the model, not
// user-facing text.
const HERO_SHOT_RULES = [
  { rule_id: "R01_ROOM_MASTER_HERO", name: "Room Master Hero", use_when: "full room or dominant zone clearly readable, layout/scale understandable",
    camera_technique: { camera_angle: "eye-level architectural interior perspective", lens_feel: "22-28mm architectural interior lens feel", composition: "wide balanced composition, straight verticals, full-room context", depth_of_field: "deep focus", lighting: "natural daylight balanced with interior lighting", recommended_aspect_ratios: ["16:9","4:3"] },
    disallow: ["do not over-tighten into a detail crop", "do not move architectural features", "do not invent additional room width, height, windows, doors, furniture, fixtures, or built-ins"] },
  { rule_id: "R02_OPEN_PLAN_LIFESTYLE_HERO", name: "Open Plan Lifestyle Hero", use_when: "two or more connected zones visible (kitchen+dining, kitchen+living, living+dining, etc)",
    camera_technique: { camera_angle: "3/4 lifestyle perspective across connected zones", lens_feel: "24-35mm interior lifestyle lens feel", composition: "foreground/midground/background layering showing zone relationship", depth_of_field: "medium to deep focus", lighting: "natural daylight, warm interior balance", recommended_aspect_ratios: ["16:9","4:3"] },
    disallow: ["do not invent missing zones", "do not crowd furniture into circulation paths", "do not block sliders, doors, halls, fireplaces, islands, or major openings"] },
  { rule_id: "R03_FOREGROUND_DEPTH_HERO", name: "Foreground Depth Hero", use_when: "strong visible leading lines: runner, island edge, cabinet run, sofa line, hallway edge, flooring direction",
    camera_technique: { camera_angle: "low-to-eye-level perspective aligned with visible leading lines", lens_feel: "24-28mm interior perspective lens feel", composition: "strong foreground anchor with midground/background rhythm", depth_of_field: "medium to deep focus", lighting: "balanced natural light with crisp depth cues", recommended_aspect_ratios: ["16:9","4:3"] },
    disallow: ["do not create an ultra-wide distorted look", "do not stretch the room", "do not add new space, openings, rugs, furniture, or architectural depth"] },
  { rule_id: "R04_ISLAND_HERO", name: "Island Hero", use_when: "kitchen island visible and readable — countertop, cabinet face, sink, faucet, seating face, or styling",
    camera_technique: { camera_angle: "counter-height or slightly low 3/4 angle along the island edge", lens_feel: "28-35mm editorial interior lens feel", composition: "island as foreground subject, kitchen context behind", depth_of_field: "moderate", lighting: "natural daylight with controlled countertop highlights", recommended_aspect_ratios: ["4:3","16:9","4:5"] },
    disallow: ["do not change island size, shape, color, material, sink position, faucet position, or cabinet layout", "do not add stools unless already present in the approved staged image", "do not move the island or alter its seating face"] },
  { rule_id: "R05_RANGE_HOOD_HERO", name: "Range / Hood Hero", use_when: "range, cooktop, hood, or cooking wall clearly visible",
    camera_technique: { camera_angle: "clean 3/4 or centered feature perspective facing the cooking wall", lens_feel: "35-50mm interior feature lens feel", composition: "range and hood as subject, framed by cabinetry/backsplash/counters", depth_of_field: "moderate", lighting: "natural daylight with subtle under-hood/under-cabinet glow", recommended_aspect_ratios: ["4:3","16:9","1:1"] },
    disallow: ["do not change appliance type, burner count, finish, hood style, backsplash, or cabinet layout", "do not add pot fillers, new lighting, new tile, or new appliances unless visible"] },
  { rule_id: "R06_SINK_WINDOW_HERO", name: "Sink / Window Hero", use_when: "sink wall and window clearly readable together",
    camera_technique: { camera_angle: "balanced eye-level composition centered or slightly angled toward the sink wall", lens_feel: "35mm interior feature lens feel", composition: "sink and window framed by cabinetry and counter surfaces", depth_of_field: "medium to deep focus", lighting: "bright natural daylight from the window", recommended_aspect_ratios: ["4:3","16:9","1:1"] },
    disallow: ["do not change window size/placement/exterior view", "do not change sink location, faucet type, or cabinet layout", "do not add scenery outside the window"] },
  { rule_id: "R07_APPLIANCE_DETAIL_HERO", name: "Appliance Detail Hero", use_when: "premium appliance visible: double ovens, built-in fridge, wine fridge, coffee station, laundry machines",
    camera_technique: { camera_angle: "tight 3/4 or front-biased feature composition", lens_feel: "50-70mm detail lens feel", composition: "appliance as subject with surrounding cabinetry for context", depth_of_field: "moderate shallow", lighting: "controlled natural light with realistic reflections", recommended_aspect_ratios: ["4:5","1:1","4:3"] },
    disallow: ["do not invent appliances", "do not change appliance finish, display panel, handle style, cabinet integration, or location", "do not add readable brand logos or fake display text"] },
  { rule_id: "R08_FURNITURE_GROUPING_HERO", name: "Furniture Grouping Hero", use_when: "staged seating group, bedroom group, office setup, reading nook, or flex-space grouping visible",
    camera_technique: { camera_angle: "eye-level or slightly low lifestyle composition facing the furniture grouping", lens_feel: "28-40mm interior lifestyle lens feel", composition: "furniture grouping as subject, room boundaries/anchors preserved", depth_of_field: "medium", lighting: "natural daylight balanced with room lighting", recommended_aspect_ratios: ["4:3","16:9","4:5"] },
    disallow: ["do not move the furniture grouping outside its approved zone", "do not block fireplace, doors, windows, sliders, hallways, built-ins, or circulation", "do not add major furniture pieces not present in the approved staged image"] },
  { rule_id: "R09_DINING_TABLE_HERO", name: "Dining Table Hero", use_when: "dining table and chairs clearly visible, table itself is the subject (not just open-plan relationship)",
    camera_technique: { camera_angle: "warm 3/4 lifestyle perspective at seated or standing height", lens_feel: "35-50mm lifestyle lens feel", composition: "dining table as subject with chairs, centerpiece, and adjacent zone context", depth_of_field: "moderate", lighting: "soft natural daylight with warm lifestyle balance", recommended_aspect_ratios: ["4:3","16:9","4:5"] },
    disallow: ["do not move the dining table under a different fixture", "do not invent chandeliers, pendants, sconces, additional chairs, or table settings", "do not block sliders, doors, walkways, or kitchen circulation"] },
  { rule_id: "R10_MATERIAL_FINISH_DETAIL", name: "Material / Finish Detail", use_when: "distinctive visible material/finish/hardware/millwork/flooring/backsplash/countertop edge/built-in worth a close-up",
    camera_technique: { camera_angle: "tight low or side-angle editorial detail composition", lens_feel: "50-70mm detail lens feel", composition: "surface, edge, grain, hardware, or finish as main subject", depth_of_field: "shallow", lighting: "soft directional light highlighting texture without exaggeration", recommended_aspect_ratios: ["4:5","1:1","4:3"] },
    disallow: ["do not change material type, color, pattern, veining, hardware, cabinet profile, tile layout, flooring species, or finish level", "do not exaggerate luxury beyond what is visible"] },
  { rule_id: "R11_FIXTURE_DETAIL", name: "Fixture Detail", use_when: "visible fixture: faucet, pendant, chandelier, sconce, fireplace, ceiling fan, or specialty lighting",
    camera_technique: { camera_angle: "close-up or medium feature composition aligned to the fixture", lens_feel: "50-85mm fixture/detail lens feel", composition: "fixture as subject with soft room context", depth_of_field: "shallow to moderate shallow", lighting: "controlled highlights preserving realistic fixture finish", recommended_aspect_ratios: ["4:5","1:1","4:3"] },
    disallow: ["do not invent fixtures", "do not change fixture type, count, location, finish, shape, scale, or mounting point", "do not add a chandelier, pendant, sconce, faucet, fireplace, or fan not visible in the approved image"] },
  { rule_id: "R12_INDOOR_OUTDOOR_CONNECTION_HERO", name: "Indoor / Outdoor Connection Hero", use_when: "slider, patio door, balcony door, large window, or outdoor view visible and connected to the interior",
    camera_technique: { camera_angle: "lifestyle composition angled across interior space toward the exterior opening", lens_feel: "24-35mm interior lifestyle lens feel", composition: "interior foreground with visible exterior connection in midground/background", depth_of_field: "medium to deep focus", lighting: "balanced exposure between interior and exterior daylight", recommended_aspect_ratios: ["16:9","4:3"] },
    disallow: ["do not change the exterior view", "do not add landscaping, pools, patio furniture, decks, balconies, skyline, water, or outdoor features not visible", "do not alter slider, door, window, or opening location"] },
];

function callClaudeVision(imageBase64, mimeType, apiKey) {
  // Only send rule_id + use_when to the model — not full camera_technique/disallow
  // text — so Claude's job is just "pick the right rule," not "transcribe a large
  // object verbatim." This is what was causing truncated/invalid JSON: asking for
  // the full camera_technique + disallow copied per shot blew past max_tokens
  // once more than a couple of shots were suggested.
  const ruleSummaries = HERO_SHOT_RULES.map(r => ({ rule_id: r.rule_id, name: r.name, use_when: r.use_when }));
  const rulesJson = JSON.stringify(ruleSummaries);

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
        { type: "text", text:
          "You are analyzing an already-staged real estate interior photo to suggest premium hero/detail shots for a real estate marketing tool, using a FIXED catalog of photographer-direction rules. Look ONLY at what is actually visible in this specific photo.\n\n" +
          "IMPORTANT FRAMING NOTE: do not cluster your suggested crops toward the ceiling or upper portion of the frame — there is rarely anything worth featuring on a ceiling. Bias your suggested bboxes toward the foreground and floor-level two-thirds of the image, where furniture, fixtures, cabinetry, and staged assets actually are. A bbox with y-origin near 0 covering mostly ceiling/upper-wall is almost always wrong for a hero/detail shot.\n\n" +
          "RULE CATALOG (select the single best-fitting rule_id for each suggested shot by name/use_when; do not invent new rule_ids):\n" + rulesJson + "\n\n" +
          "Return ONLY valid JSON, no other text, no markdown fences, no explanation. Keep each field SHORT — reason must be one short sentence, not a paragraph. Exact shape:\n" +
          "{\n" +
          '  "room_type": "<short description of the room type as shown>",\n' +
          '  "hero_shots": [\n' +
          "    {\n" +
          '      "id": <integer, 1-indexed>,\n' +
          '      "rule_id": "<one rule_id from the catalog above>",\n' +
          '      "name": "<short user-facing shot name>",\n' +
          '      "confidence": "high" | "medium" | "low",\n' +
          '      "bbox": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },\n' +
          '      "reason": "<one short sentence: what specific materials/colors/objects are visible in this crop>"\n' +
          "    }\n" +
          "  ]\n" +
          "}\n\n" +
          "bbox values are fractions of the image width/height (0-1), x/y is the top-left corner. Only suggest a shot where its rule's use_when condition is clearly satisfied by what is actually visible. Suggest between 3 and 8 hero shots — fewer, well-chosen shots are better than many marginal ones."
        }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) {
            reject(new Error(`Claude API error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,300)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(new Error("Claude API parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Attaches the full camera_technique/disallow from the matched rule — done
// programmatically, not by asking Claude to transcribe it, so it's always
// exactly correct and never truncated.
function enrichWithRuleData(heroShots) {
  return heroShots.map(shot => {
    const rule = HERO_SHOT_RULES.find(r => r.rule_id === shot.rule_id);
    if (!rule) {
      console.warn(`detect-hero-shots: unknown rule_id "${shot.rule_id}" for shot ${shot.id}, dropping camera_technique`);
      return { ...shot, camera_technique: {}, render_constraints: ["preserve architecture", "do not invent new fixtures"], disallow: [] };
    }
    return {
      ...shot,
      camera_technique: rule.camera_technique,
      render_constraints: ["preserve architecture", "do not invent new fixtures", "do not move visible furniture, fixtures, or built-ins"],
      disallow: rule.disallow,
    };
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    console.log(`detect-hero-shots: image ${Math.round(imageBase64.length/1024)}KB, calling Claude Vision`);
    const result = await callClaudeVision(imageBase64, mimeType || "image/jpeg", apiKey);

    const textBlock = result?.content?.find(b => b.type === "text");
    if (!textBlock) throw new Error("No text content in Claude response");

    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/,"");
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error("Claude did not return valid JSON: " + cleaned.slice(0, 200));
    }

    if (!Array.isArray(parsed.hero_shots)) {
      throw new Error("Response missing hero_shots array");
    }

    // TEMP DEBUG (July 2026 — rule-mismatch investigation, remove once resolved):
    // logs Claude's raw pre-enrichment picks so we can see exactly which rule_id
    // it matched each shot to, alongside its own reason text, before the fixed
    // catalog's composition/camera_technique gets bolted on. This is what lets us
    // confirm whether e.g. an island sink is getting force-fit into R06_SINK_WINDOW_HERO
    // (a wall-sink rule) instead of flagging a genuine gap in the 12-rule catalog.
    console.log("detect-hero-shots: RAW pre-enrichment picks:", JSON.stringify(
      parsed.hero_shots.map(s => ({ id: s.id, rule_id: s.rule_id, name: s.name, reason: s.reason, confidence: s.confidence }))
    ));

    parsed.hero_shots = enrichWithRuleData(parsed.hero_shots);

    console.log(`detect-hero-shots: ${parsed.hero_shots.length} shots suggested for ${parsed.room_type}`);
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error("detect-hero-shots error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
