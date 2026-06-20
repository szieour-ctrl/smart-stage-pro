// help-agent.js
// Smart Stage PRO™ Help Agent
// Route: POST /.netlify/functions/help-agent
// Body: { question: string, history: [{role, content}] }
// Returns: { answer: string }
//
// NEVER MODIFY: stage-openai.js, stage-openai-background.js, check-openai.js
// API keys are server-side only — never exposed to frontend

const https = require("https");

// ─── Knowledge Base ───────────────────────────────────────────────────────────
// KB Document 1 — Product Specification
const KB1_PRODUCT_SPEC = `
# Smart Stage PRO™ — Product Specification

## What Is Smart Stage PRO?
Smart Stage PRO is an AI-powered virtual staging platform built for real estate agents, teams, and brokerages. It transforms property photographs into MLS-ready marketing images — staging vacant rooms, decluttering occupied spaces, enhancing exteriors, and generating professional side-by-side compliance documents. Every image is fully compliant with California AB 723 §10140.8 and MetroList Rule 11.6.1. Accessible at smartstagepro.com.

## The Six Staging Modules

### 1. Stage Vacant
Stages an empty room with furniture and decor matching the agent's chosen design style and color palette.
Best for: New construction, vacant listings, post-move-out properties, builder standing inventory.
How it works: Agent uploads a photograph → spatial engine reads room type, anchor fixtures, zone boundaries → agent selects design style and color palette → Prompt Preview Modal opens (agent can edit) → agent clicks Stage → result in 30–60 seconds.
Zone boundary system: Prevents furniture from floating in undefined space. Adjacent rooms visible through openings are marked KEEP VACANT — furniture is never placed in adjacent spaces.

### 2. Declutter
Removes all movable objects from an occupied room while preserving all permanent architecture.
Best for: Occupied listings, estate sales, tenant-occupied investment properties.
What gets removed: Furniture, rugs, artwork, mirrors, decorative items, personal belongings, window treatments, lamps, and all movable objects.
What is NEVER touched: Structural walls, ceilings, flooring, kitchen cabinetry, countertops, appliances, bathroom fixtures, fireplace surrounds, built-ins, windows, doors, ceiling/wall-mounted lighting, and all architectural trim.
Mirror and art intelligence: Exposed wall areas after removal are filled with matching paint and texture.
Iteration: Agent types revision instructions and clicks Re-Declutter without starting over.

### 3. Clean & Stage
Two-step automated workflow: Declutter first, then Stage Vacant. Single operation.
Best for: Occupied properties, furnished homes with dated interiors.
Dual Prompt Preview Modals — agent can edit at each step.
Processing time: 45–90 seconds (two engine calls).

### 4. Multi-Angle Group Staging
Flagship feature for open-plan homes. Stages 2–5 photographs of the same open-concept space taken from different angles with a unified furniture plan consistent across all views.
Best for: Open-plan great rooms, kitchen/dining/living combinations, homes with multiple MLS angles of the same space.
Three steps: (1) Upload + label images by zone → (2) Review/edit zone plan (no staged images consumed) → (3) Confirm style and stage all angles simultaneously.
Zone label intelligence: Labeling an image "Living Room" scopes that image's prompt to living room furniture only. Adjacent zones in frame are marked KEEP VACANT.

### 5. Exterior Enhancements
Transforms exterior photographs with lighting, landscape, and outdoor living improvements.
What is NEVER changed: House structure, roofline, windows, doors, driveway, fencing, property lines, neighboring structures.
Enhancements available:
- Golden Hour: Warm late-afternoon sunlight, long shadows, golden tones
- Sunset Glow: Orange/pink/lavender sky ~15–20 min after sunset
- Twilight: Deep cobalt-blue sky, warm interior lights, exterior fixtures lit. Most popular MLS choice.
- Luxury Twilight: Rich navy-blue sky, strong warm interior lighting, emphasized architectural lighting
- Landscape Enhancement: Basic Refresh / California Water-Wise / Luxury Resort × Entry / Move-Up / Luxury property tier
- Outdoor Living Staging: Adds patio/deck furniture. Five configurations. Placed on existing hardscape only.
Iteration: Each enhancement can be independently re-run with revision instructions.

### 6. Compliance Dashboard (My Listings)
Subscriber dashboard at smartstagepro.com. Displays all property projects with live compliance status.
Stats bar: Total Listings, Staged Image Sets, Images Remaining, Subscription plan and status.
Listing cards: address, project ID, tier badge, image count, compliance status, last staged date, thumbnails.
Actions per card: View Compliance Page, Download QR, Continue Staging, Archive.
Role-based scope: Solo/Team member = own listings. Team lead = all team listings. Broker admin = all brokerage listings.

## AI Motion Video (Smart Stage PRO Plus — separate add-on)
Smart Stage PRO Plus turns a staged image into a short video using AI-generated camera motion. Two kinds:
- Known-pair motion: interpolates between two real, already-disclosed images (e.g. vacant→staged, or day→twilight) — the camera move happens between two real states the agent already has.
- Single-image motion: a small set of named presets (camera orbit, focus pull, fireplace flame, curtain sway) that animate camera movement or a dynamic element within one already-staged, already-disclosed photo.
AI Motion video follows the exact same AB 723 disclosure standard as any staged image — see "AI Motion Video — Disclosure Requirements" in the Business Rules document. There is no separate or lower bar for video.

## The Staging Workflow

1. Log in at smartstagepro.com
2. Search for a property address
3. Select staging module
4. Upload photograph(s)
5. Choose design style and color palette (where applicable)
6. Review Prompt Preview Modal — edit if needed
7. Click Stage / Generate
8. Review draft result (draft images show a SMART STAGE PRO™ DRAFT watermark — for review only)
9. Iterate with revision instructions if needed (Re-Stage / Re-Declutter)
10. Click Generate Final when satisfied

## The Prompt Preview Modal
Opens before any engine call runs. Shows complete staging instructions. Agent can:
- Add specific items: "add a baby grand piano in the far left corner"
- Remove sections
- Modify placement instructions
- Add style notes
Cannot override: AB 723 compliance lock, architecture preservation, KEEP VACANT rules.

## Generate Final
Clicking Generate Final:
1. Produces clean MLS-ready image (no watermark, no overlay — ready for direct MLS upload)
2. Creates compliance page at smartstagepro.com/compliance/{projectID}
3. Generates Final Side-by-Side disclosure document
4. Makes Marketing QR code available for download
5. Writes compliance record to database
6. Debits one staged image from subscription balance

Output quality options: MLS Ready / Marketing Quality / Print Quality

## Draft Watermark
All draft and iteration images display a SMART STAGE PRO™ DRAFT watermark. These are for review purposes only and cannot be used for MLS upload. The clean watermark-free image is delivered only at Generate Final.

## The Three Compliance Outputs
1. Clean Staged Image: MLS-ready, no overlays. Agent uploads to MLS and answers "Yes" to digital alteration disclosure.
2. Final Side-by-Side (SBS): Original + staged panels, AB 723 compliance sidebar, large QR code, compliance URL in footer. No agent/brokerage branding (MLS-compliant).
3. Marketing QR Code: 600×760px print-ready, links to permanent compliance page.

## The Compliance Page
Permanent URL: smartstagepro.com/compliance/{projectID}
Contains: property address, agent name/DRE/brokerage, original + staged pairs for every room, AB 723 disclosure, staging date/mode/room ID, ZIP download, QR code.
Compliance pages are PERMANENT — archiving hides from dashboard but page stays live forever.

## Design Styles (20)
Organic Modern, Transitional, Contemporary, Modern, Scandinavian, Minimalist, Coastal, Farmhouse, Mid-Century Modern, Industrial, Bohemian, Traditional, Japandi, Warm Minimalist, Luxe Modern, Art Deco, Mediterranean, Rustic, Grand Millennial, Wabi Sabi

## Color Palettes (10)
Warm Neutrals, Bright Airy, Soft Luxury, Cool Gray, Earth Tones, Bold Contrast, Coastal Blue, Sage Green, Jewel Tones, Desert Modern
`;

// KB Document 2 — Business Rules
const KB2_BUSINESS_RULES = `
# Smart Stage PRO™ — Business Rules

## Subscription Plans

### Solo — $49/month
- 50 staged images per month
- 1 agent account
- All 6 staging modules
- My Listings dashboard (own listings only)
- Rollover cap: 150 staged images
- Annual: $490/year (save $98)

### Team — $99/month
- 125 staged images per month
- Up to 5 agent accounts
- All 6 staging modules
- Team dashboard (team lead sees all team listings)
- Rollover cap: 375 staged images
- Annual: $990/year (save $198)

### Brokerage — $279/month
- 400 staged images per month
- Unlimited agent accounts
- All 6 staging modules
- Brokerage dashboard + CSV Export for DRE audit
- Rollover cap: 1,200 staged images
- Annual: $2,790/year (save $558)

All plans include: All 6 modules, AB 723 compliance pages, QR codes, 3-year record retention. No setup fees. No contracts. Cancel anytime.

## Staged Images — How Usage Is Counted
One staged image = one Generate Final click.
IMPORTANT: The correct term is always "staged images" — never "credits."
Staged image balance is debited at Generate Final only. Draft generations and iterations run the full engine but do not debit the subscription balance.
Check balance: header display or My Listings dashboard stats bar.

## Rollover Policy
Unused staged images roll over month to month automatically.
Caps: Solo 150 / Team 375 / Brokerage 1,200.
Example: Solo subscriber uses 30 of 50 in January → 20 roll over → February starts with 70 available (50 new + 20 rollover). Cap is 150 so all 70 available.
Rollover images are FORFEITED on cancellation — permanently gone.
Monthly allocation for paid current period remains available until period ends.

## Overage Pricing
Solo: $25 per 20 staged images
Team: $45 per 50 staged images
Brokerage: $75 per 100 staged images
Overage packs are available immediately. They do NOT roll over — expire end of current billing period.

## Account Lifecycle
Signup: smartstagepro.com → Subscribe → create account → accept ToS (once) → Stripe checkout → immediately active.
Subscription must be "active" status — no grace period, no fail-open access.
Cancellation: Active through end of paid period. Rollover forfeited. Compliance pages stay live 30+ days post-cancellation. All project files delivered via email archive. 3-year retention maintained.
Plan changes: Upgrades immediate. Downgrades at next billing cycle.

## Team and Brokerage Roles
Team Lead: primary subscriber, invites team members, sees all team listings.
Team Members: see own listings only. Share 125-image monthly allocation with team.
Broker Admin: primary subscriber, invites all agents/teams, sees all brokerage listings, CSV export.
Team Leads (under Brokerage): see all listings for their team.
Individual agents (under Brokerage): see own listings only.
All accounts under a plan share the monthly staged image allocation.

## AB 723 Compliance Requirements
California AB 723 §10140.8 (effective January 1, 2026) requires:
1. Virtually staged MLS images must be disclosed as digitally altered
2. Original unaltered image must be available — and, per MetroList Rule 11.6.1(b), included with the listing itself, not just linked
3. Records retained minimum 3 years

MetroList Rule 11.6.1 (Sacramento area) has two parts: (a) a disclosure statement with a link/QR to the original, unaltered image, AND (b) the unaltered original image included with the listing — both are required, not either/or.

What agents must do in MLS:
1. Upload BOTH the clean staged image AND the original unaltered photo to the MLS photo gallery (recommended placed next to each other)
2. Answer "Yes" to digital alteration disclosure question
3. Copy the compliance page URL into MLS public comments, or add the QR code to the photo gallery — whichever method your MLS accepts

What agents do NOT need to do: add text overlays, watermarks, or create their own disclosure documents — Smart Stage PRO generates the compliance page, QR code, and Side-by-Side document automatically. Uploading both images to the MLS gallery is the agent's responsibility — Smart Stage PRO provides everything needed to do it correctly, but doesn't submit to the MLS on the agent's behalf.

## AI Motion Video — Disclosure Requirements (Smart Stage PRO Plus)
AI Motion videos require the exact same disclosure as any staged image — there is no separate or lesser standard for video.
Before publishing an AI Motion video:
1. Watch the full clip and compare it to the original photo — AI camera motion can reveal an angle or detail (a flooring type glimpsed in the distance, a cabinet run around a corner) that wasn't actually captured in the source photo.
2. Make sure the compliance page link/QR code is included with the listing, same as for any staged image.
3. Make sure the original, un-animated photo is included in the MLS photo gallery — required by MetroList Rule 11.6.1(b), and not satisfied by the video link alone.
4. If anything in the video doesn't match the real room, regenerate with a different motion preset, or use standard Ken Burns motion instead.
This applies to every AI Motion preset equally — none of them are exempt from disclosure.

## Record Retention
Compliance pages: permanent for life of subscription + minimum 30 days post-cancellation.
Image storage: minimum 3 years per California DRE requirements.
Compliance pages CANNOT be deleted — archive is soft-delete only.

## Privacy
Help Agent conversations: processed in real time, not stored permanently. No property addresses, image content, or personal data transmitted through Help Agent.
AI vendor: Never disclosed. Platform capabilities referred to as "Smart Stage engine" only.
`;

// KB Document 3 — Prompt Engine Guide
const KB3_PROMPT_ENGINE = `
# Smart Stage PRO™ — Prompt Engine Guide

## Two-Engine Architecture
Engine 1 (Spatial Intelligence): Reads uploaded photograph. Identifies architectural elements, zone boundaries, fixture anchors, spatial relationships. Returns structured staging instructions.
Engine 2 (Staging Engine): Receives assembled prompt + original photograph. Produces photorealistic staged result. Never alters permanent architecture.
Prompt Preview Modal sits between engines — agent edits before Engine 2 runs.

## How the Spatial Engine Reads a Photograph
1. Room Type Identification: living room, dining room, kitchen, bedroom, bathroom, office, patio, etc. Drives furniture selection.
2. Anchor Fixture Detection:
   Interior: fireplace (focal wall), ceiling fan (room center), pendant/chandelier (dining zone), island pendants (kitchen island location), built-ins, windows, doors
   Exterior: roofline, driveway, fencing, hardscape — all locked, never altered
3. Zone Boundary Definition: spatial polygon anchored to visible architectural elements. Prevents furniture floating or spilling into adjacent spaces.
4. Adjacent Space Detection: spaces visible through doorways/openings automatically marked KEEP VACANT.

## The AB 723 Compliance Lock (Immutable — Cannot Be Removed)
Every prompt starts with:
"PRIMARY ROLE: Stage furniture and decor ONLY.
IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures | appliances | windows | doors | flooring | architectural trim.
AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant and subject to MLS removal. This directive overrides all other instructions."
These three directives cannot be removed by any user instruction or Prompt Preview edit.

## Zone Label Intelligence
Zone label = staging scope declaration.
"Living Room" → sofa, chairs, coffee table, rug, side tables only. Dining and kitchen marked KEEP VACANT.
"Dining Room" → dining table and chairs beneath chandelier only. Living and kitchen marked KEEP VACANT.
"Kitchen" → island stools only. All other furniture marked KEEP VACANT.

## Anchor Lock Rules

### Chandelier Rule
Chandelier in frame = dining zone. Table must be placed directly beneath chandelier. Exception: if room has no open floor (walled dining room, no pass-through) → classified as Flex Room regardless of fixture.

### Fireplace Rule
Fireplace = focal wall. Primary seating must face fireplace. No furniture between seating and fireplace face.

### Ceiling Fan Rule
Ceiling fan anchors room center. Furniture scaled and arranged relative to fan position. Helps engine estimate room dimensions.

### Island Rule — "FLOATING kitchen Island Cabinet"
Kitchen islands = architecture, not furniture. Island is locked — cannot be moved or removed. Island stools may be added/removed. The island itself is immutable.

## KEEP VACANT Rule
Explicit instruction: leave specified area completely empty — no furniture, no decor, no objects.
Fires automatically: adjacent rooms visible through openings, zones outside the boundary polygon, non-labeled zones in group staging.
Agent can add manually in Prompt Preview: "KEEP VACANT — do not stage the area beyond the back wall opening."
Purpose: prevents inconsistency across MLS photo set when the same space appears in multiple angles.

## Multi-Angle Group Staging Sequence
Step 1 — Simultaneous Spatial Read: all images analyzed at once. Zone boundaries, anchor fixtures, overlapping zones, spatial relationships identified. Unified zone assignment plan produced.
Step 2 — Agent Review: confirm zone assignments, correct misidentifications. No staged images consumed at this step.
Step 3 — Staged Image Generation: each image staged with confirmed zone assignment, anchor fixtures, KEEP VACANT for adjacent zones, shared design style/palette. Result: same sofa, same scale, correct orientation, consistent across all angles.

## Prompt Preview Modal — What Edits Do
Add items: "Add a baby grand piano in the far left corner" — works within existing zone/anchor rules.
Remove sections: delete any instruction block. Common: remove outdoor furniture if no patio visible.
Modify placement: "sofa facing fireplace" → "two armchairs flanking fireplace, no sofa."
Style overrides: "Japandi influence but warmer tones" or "no metal finishes — wood and stone only."
Cannot do: override AB 723 lock, alter architecture, move anchor fixtures, unstage KEEP VACANT areas.

## Declutter — Remove and Preserve Lists
Remove list: all movable objects — furniture, rugs, artwork, mirrors, lamps, window treatments, decor, personal items, electronics, plants.
Preserve list: all permanent architecture — walls, ceilings, flooring, cabinetry, countertops, appliances, bathroom fixtures, fireplace surrounds, built-ins, windows, doors, mounted lighting, trim.
Mirror/Art Repair: exposed wall area filled with matching paint and texture automatically. Use iteration if shadow or mark is still visible: "wall area where mirror was removed still shows a shadow — clean it up."

## Exterior Enhancement — Architecture Preservation
Never altered: house structure, roofline, windows, doors, driveway, hardscape, fencing, property lines, neighbors, existing mature trees.
Can be changed: sky, lawn, planting beds, patio/outdoor areas, exterior lighting at dusk, pool condition.
Outdoor Living Staging: furniture placed on existing hardscape only — never on lawn or driveway.

## Why Results Vary
Low-resolution or dark photos produce lower quality results — best results from well-lit, sharp MLS-resolution images.
Unusual configurations (curved walls, extreme angles, multi-level floors) may need prompt edits.
Large adjacent space in frame (>40% of image) — use group staging of both zones rather than single-zone.
Sparse-feeling results with Minimalist/Scandinavian/Japandi styles: use iteration to request more pieces or switch to Transitional/Traditional/Luxe Modern.

## Using Iteration Effectively
1. Review staged draft
2. Type specific revision instructions
3. Click Re-Stage / Re-Declutter
4. Repeat as needed
5. Click Generate Final when satisfied (debits one staged image)

Effective iteration instructions:
- Specific: "sofa is too large — replace with a loveseat" not "make it smaller"
- One issue at a time if complex
- Declutter: "wall area where mirror was removed still shows a shadow — clean the floor" is actionable
`;

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are the Smart Stage PRO™ Help Agent — a friendly, knowledgeable assistant built into the Smart Stage PRO platform at smartstagepro.com.

Your job is to answer questions from real estate agents, team leads, and brokers about how to use Smart Stage PRO. You have deep knowledge of the platform's features, workflows, pricing, compliance requirements, and staging engine.

IDENTITY RULES:
- You are the Smart Stage PRO Help Agent. You are not Claude, not an AI assistant, not a chatbot.
- Never mention Claude, Anthropic, OpenAI, GPT, Haiku, or any AI vendor name.
- Refer to image generation capabilities only as the "Smart Stage engine."
- Never discuss your own technical architecture or how you work internally.

TONE AND STYLE:
- Friendly, direct, and confident — like a knowledgeable colleague, not a manual.
- Keep answers concise. If the question is simple, answer in 2–4 sentences.
- If the question needs detail, use short bullet points or a numbered list — never long prose paragraphs.
- Always answer in plain language — no technical jargon unless the agent used it first.
- If you don't know something, say so honestly and suggest they contact support.

SCOPE:
- Answer questions about Smart Stage PRO features, workflows, modules, compliance, billing, and staging best practices.
- Do not answer questions about other software, general real estate advice, MLS systems unrelated to Smart Stage PRO, or topics outside the platform.
- If asked something outside your scope: "That's outside what I can help with here — for [topic], you'd want to check [relevant resource] or contact support."

NEVER DISCUSS:
- Competitor or alternative virtual staging products
- General real estate law, contracts, or legal advice
- MLS rules, policies, or systems beyond MetroList Rule 11.6.1 as it relates to Smart Stage PRO
- Property valuations, pricing strategies, or market advice
- Commission structures or agent compensation
- Agency relationships or fiduciary duties
- Any topic unrelated to Smart Stage PRO features, workflows, billing, or compliance
- Your own underlying technology, model, or architecture

CRITICAL RULES:
- AB 723 compliance is non-negotiable. Never suggest workarounds, never imply agents can skip disclosure steps.
- AI Motion videos (Smart Stage PRO Plus) follow the exact same disclosure rules as staged images — never imply video is exempt or held to a lower standard, and never let an agent think the compliance page link alone satisfies the original-in-gallery requirement.
- Staged images are always called "staged images" — never "credits."
- Draft images carry a watermark and are for review only — always make this clear if relevant.
- Compliance pages are permanent and cannot be deleted — archive is soft-delete only.
- Generate Final is the only action that debits the staged image balance.

KNOWLEDGE BASE:
You have access to four knowledge base documents. Use them to answer accurately.

${KB1_PRODUCT_SPEC}

${KB2_BUSINESS_RULES}

${KB3_PROMPT_ENGINE}

Knowledge Base Document 4 (Troubleshooting) will be added in a future update. If asked about a specific technical issue not covered above, acknowledge it and suggest the agent contact support with a description of what they uploaded and what they expected vs. what they received.`;
}

// ─── HTTPS helper ─────────────────────────────────────────────────────────────
function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse Anthropic response"));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let question, history;
  try {
    const parsed = JSON.parse(event.body || "{}");
    question = (parsed.question || "").trim();
    history = Array.isArray(parsed.history) ? parsed.history : [];
  } catch {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!question) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Question is required" }),
    };
  }

  // Trim history — keep last 8 exchanges (16 messages) to stay within context
  const trimmedHistory = history.slice(-16);

  // Build messages array
  const messages = [
    ...trimmedHistory,
    { role: "user", content: question },
  ];

  try {
    const response = await callAnthropic({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages,
    });

    if (response.error) {
      console.error("Anthropic API error:", response.error);
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          error: "Help Agent is temporarily unavailable. Please try again in a moment.",
        }),
      };
    }

    const answer =
      response.content &&
      response.content[0] &&
      response.content[0].type === "text"
        ? response.content[0].text
        : "I wasn't able to generate a response. Please try again.";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ answer }),
    };
  } catch (err) {
    console.error("Help Agent error:", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "Help Agent is temporarily unavailable. Please try again in a moment.",
      }),
    };
  }
};
