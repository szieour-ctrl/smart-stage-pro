/**
 * PHASE 5A — HAIKU SPATIAL READ PROMPT (FINAL REBUILD)
 * 
 * This is the COMPLETE Haiku prompt to embed in group-spatial-read-background.js
 * Replace the entire buildHaikuPrompt() or runSpatialRead() function with this.
 * 
 * Returns clean 6-field zones with furnishing logic based on Tier 1/2 anchors.
 */

const buildHaikuSpatialReadPrompt = (imageAnalysis) => {
  return `YOU ARE A PROFESSIONAL SPATIAL ARCHITECT & ARCHITECTURAL ANALYZER.

YOUR TASK: Read the uploaded property photo and identify functional furnishing zones based ONLY on visible architecture, fixtures, and spatial boundaries.

CRITICAL RULES:
1. Analyze ONLY what is visible in the photograph
2. NO INFERENCE below confidence thresholds (see below)
3. Preserve ALL architectural elements exactly as shown
4. NO directional language ("left of", "adjacent to", etc.)
5. NO furniture placement — facts only
6. Hallway/circulation zones must output "LEAVE VACANT"

ZONE IDENTIFICATION:
Identify zones using: walls, partial walls, openings, doorways, windows, sliding glass doors, fireplaces, kitchen islands, cabinetry, ceiling changes, chandeliers, pendant lighting, ceiling fans, built-ins, columns.

CONFIDENCE THRESHOLDS (Below = "None"):
- Boundaries: 70%+
- Fixtures: 70%+
- Cabinetry: 70%+
- Windows/Doors: 70%+
- Anchor Point: 60%+ (IF Tier 1 anchor exists)
- Focal Point: 70%+

TIER 1 ANCHORS (Explicit furnishing instructions at 60%+ confidence):
- Fireplace (gas or wood-burning insert)
- Ceiling fan
- Chandelier or pendant light groups
- Recessed light groups positioned to anchor seating

TIER 2 ZONES (No Tier 1 anchor):
- Open floor space, no fixture
- Generic furnishing instructions
- GPT2 infers placement

FURNISHING FIELD LOGIC:

IF Zone = Kitchen:
"Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed).
Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Dining & Anchor = Chandelier/Pendant Lights (Tier 1):
"Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Dining & No Anchor (Tier 2):
"Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Living & Anchor = Fireplace (Tier 1):
"Place an area rug proportional for the seating group 18\" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living & Anchor = Ceiling Fan (Tier 1):
"Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living & No Anchor (Tier 2):
"Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Hallway or Circulation or Entry or Foyer or Passage:
"LEAVE VACANT"

OUTPUT FORMAT (STRICT JSON):

Return ONLY valid JSON array. One object per zone. NO additional text, NO markdown, NO explanations.

[
  {
    "zoneName": "Kitchen",
    "boundaries": "...",
    "fixtures": "...",
    "cabinetry": "...",
    "windowsDoors": "...",
    "anchorPoint": "...",
    "focalPoint": "...",
    "furnishing": "..."
  },
  {
    "zoneName": "Dining Zone",
    "boundaries": "...",
    "fixtures": "...",
    "cabinetry": "...",
    "windowsDoors": "...",
    "anchorPoint": "...",
    "focalPoint": "...",
    "furnishing": "..."
  }
]

STRICT RULES FOR EACH FIELD:

zoneName: Exact zone type (Kitchen, Dining Zone, Living/Great Room, Hallway/Circulation, Bedroom, etc.)

boundaries: Describe zone perimeter using architecture only. Example: "Left: island edge. Right: fireplace wall. Front: hallway. Back: window wall."

fixtures: List ALL ceiling and wall-mounted fixtures visible. If none at 70%+ confidence: "None".

cabinetry: List all built-in cabinetry types (upper, lower, island, etc.). If none visible: "None".

windowsDoors: List all windows, glass doors, openings. Example: "Sliding glass doors (4-panel, black frame, center-back). Single window (upper left)". If none: "None".

anchorPoint: Tier 1 anchor ONLY if 60%+ confidence AND zone is Kitchen/Dining/Living. Otherwise "None".
Examples: "Fireplace (center-right wall)", "Ceiling fan (center-room)", "Chandelier (center-dining)", "None".

focalPoint: Describe focal reference. Can be architectural (fireplace wall, window wall) or fixture-based. NOT furniture placement.

furnishing: EXACT instruction from logic rules above. DO NOT MODIFY. Use zone name and anchor presence to select correct instruction.

---

Now analyze the uploaded photo and return ONLY the JSON array. No other output.`;
};

module.exports = { buildHaikuSpatialReadPrompt };
