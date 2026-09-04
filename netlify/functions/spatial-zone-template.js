// spatial-zone-template.js — SHARED MODULE (not a Netlify function endpoint — no exports.handler)
//
// v6.3 Spatial Zone Analysis template — replaces the v1 Pass 0-6 Spatial Scene Compiler
// template. v1's ChatGPT-architected compiler pipeline was scrapped after testing showed
// prompt bloat/drift; v6.3 is leaner and fixture-anchored instead: Original Image
// Immutability Lock, a mandatory fixture inventory + contradiction check, and an explicit
// Fixture-Furniture Contradiction Enforcement hierarchy (Fireplace > Chandelier > Ceiling
// Fan > Kitchen Fixtures > Furniture) replace v1's four-class Zone Behavior system.
// Required by both group-spatial-read.js (Multi-Angle Group Stage, if revived) and
// stage-vacant-prompt.js (single-room Vacant Stage + Clean+Stage step 2), so the exact
// same template/assembler logic powers every staging prompt in the app — no per-file
// duplicate copies that can silently drift apart.
//
// v6.3.2 (July 2026): fixed two v6.3.1 render failures.
// (1) Chandelier hallucination — added NON-CREATION CHANDELIER RULES hard block: no
//     chandelier/pendant/overhead fixture may be added unless one exists in the original
//     photo; style/room-type/aesthetic inference are explicitly invalid grounds.
// (2) Bar stool placement errors — the expanded seating-face rule set (angle tolerances,
//     error codes) that was manually patched in as an interim v6.3.1 fix caused the model
//     to hesitate and omit stools; it has been REMOVED ENTIRELY, not restored. No bar
//     stool rule of any kind remains in this template.
// Also added: formal RENDER-PHASE IMMUTABILITY VERIFICATION (RPIV) gate with an explicit
// checklist and mandatory pass-confirmation statement (previously just a bullet list with
// no defined pass/fail behavior).
//
// v6.3.4 (July 2026): root-caused v6.3.3's bar stool failures via 5-image open-plan test
// set. Every failure occurred when the island back-overhang wasn't clearly visible in the
// photo and/or conflicted with adjacent circulation zones. Fix: a single, narrow Bar Stool
// Rule added directly in ZONE IDENTIFICATION RULES — stools ONLY where a countertop
// overhang is clearly and unambiguously visible; no inference of overhang from open floor
// clearance. Re-tested on the same 5 images: 100% success. Also, per the fixture hierarchy
// note that Kitchen Fixtures should define the Kitchen zone boundary only (never bleed into
// Dining/Living zone identity), "kitchen islands, cabinetry" was removed from the generic
// ZONE BOUNDARIES cue list, and the RPIV checklist's old "Island seating-face classification
// locked" line was removed in favor of the more specific rule now living in ZONE
// IDENTIFICATION RULES.
//
// Confirmed against a clean-text v6.3.4 master prompt on July 5, 2026: the template below
// is now an exact match. Two lines present in v6.3.2 were confirmed as intentionally
// dropped in v6.3.4, not a doc-export artifact — "Chandeliers are NEVER inferred from room
// type, event style, or aesthetic context" and "Preserve Original Image Immutability" (the
// latter under Mandatory Output Behavior) — and have been removed accordingly.
//
// v6.3.5 (Aug 19, 2026): root-caused GPT Image 2 silently dropping listed zones with no
// fixture anchor (e.g. a Dining Zone with no chandelier present in the original photo).
// Confirmed via 1340 El Camino Verde Dr: zoneList had 'dining' explicitly checked and
// correctly passed through (zoneList plumbing in index.html verified clean — this was
// never a checkbox/data bug), but the render still omitted the dining set. Root cause:
// instruction imbalance — anchored zones (Living/Dining-with-chandelier) get three
// reinforcement blocks (anchor rule, contradiction check, RPIV check) while an anchor-less
// listed zone only had one thin architectural-identification line to compete against all
// of that fixture-immutability text. Fix: added MANDATORY ZONE COVERAGE — NO SILENT
// OMISSIONS block directly after the zone list (explicit: fixture anchors resolve WHERE,
// never WHETHER, a listed zone gets furnished), plus a ZONE COVERAGE VERIFICATION step in
// OUTPUT REQUIREMENTS mirroring the existing RPIV self-check pattern already used for
// fixture immutability. No existing rules were removed or reordered.
//
// Two variable slots: {{room_assignment_variables}} and the Design DNA block (style,
// palette, buyer/feeling/staging-level, plus a per-project Furniture Profile drawn from
// STYLE_FURNITURE_VOCABULARY, plus captured furnishingsDNA continuity when present).
// The Design DNA placeholder text is unchanged from v1, so the Furniture Vocabulary /
// DNA continuity system built in the prior session plugs in here without modification.
//
// NOTE: the room-assignment placeholder wording has changed twice now between prompt
// revisions ("{{room_assignment_variables}}" in v1 vs "{{room_assignment_variables}} go
// here" in the original template and again in v6.3). assembleSpatialZonePrompt() below
// uses a regex for this substitution instead of an exact string match, so future wording
// tweaks to the surrounding text won't silently break the substitution again.
//
// v6.3.7 (Sep 2026): same "sameness" root cause, different symptom — artwork and
// decorative props (books, trays, vases, sculptural objects) had zero seeded
// vocabulary anywhere in the template, so GPT Image 2 had nothing to vary from and
// defaulted to the same generic wall art / accessories every time. Fix, additive
// only: added `artwork` and `props` arrays (3 options each) to all 12
// STYLE_FURNITURE_VOCABULARY entries, and a new pickArtworkAndProps() picker —
// seeded on style + projectId + roomName, same pattern as pickGreenery(), so
// artwork/props vary room-to-room within a project (not the same piece staged in
// every room) while staying deterministic/reproducible per room. Wired into
// buildDesignDnaVariable() as two more "direction" lines alongside the existing
// furniture ones; the "design vocabulary, not a literal catalog" framing now
// explicitly covers artwork/accessories too. No other section changed.
//
// v6.3.6 (Sep 2026): style-variety fix, Design DNA layer only — nothing above this note
// changed. Prospect feedback showed staged renders reading as too similar in styling and
// furniture within a style. Root cause: STYLE_FURNITURE_VOCABULARY only had a populated
// entry for Organic Modern; every other selectable style returned null from
// pickFurnitureProfile() and fell back to label-only prompting with no seeded furniture
// direction at all. Fix, additive only: (1) seeded STYLE_FURNITURE_VOCABULARY entries for
// the other 11 styles already present in STYLE_LABELS (Transitional, Contemporary, Luxe
// Modern, Japandi, Coastal, Mid-Century Modern, Scandinavian, Mediterranean, Farmhouse,
// Traditional, Art Deco), same shape as the existing Organic Modern entry; (2) reworded the
// per-project furnishings instruction from "use these exact pieces — do not substitute" to
// "use as a design vocabulary" so GPT Image 2 has room to vary furniture within a style
// instead of reproducing one literal recipe every time. No UI change, no new style/palette
// options exposed, no Smart Style/Smart Palette — every project keeps getting the same
// deterministic per-project/per-style profile it got before (mulberry32 seeded on
// styleLabel + projectId, unchanged), just with real vocabulary behind it now for all 12
// styles instead of 1. Zone/fixture/immutability/circulation/RPIV/AB-723 sections above are
// untouched.

const SPATIAL_ZONE_TEMPLATE = [
'SPATIAL ZONE ANALYSIS MODE',
'PRIMARY ROLE: Architectural space-planning analyst specializing in residential interiors.',
'SECONDARY ROLE: Professional luxury real-estate interior designer, home stager, and architectural photographer.',
'',
'ORIGINAL IMAGE IMMUTABILITY LOCK',
'The original photograph is the controlling source of truth. Before analyzing user intent, zones, anchors, furniture, style, or palette, preserve all permanent architecture and fixtures exactly as photographed.',
'Do NOT add, remove, relocate, resize, widen, narrow, conceal, merge, soften, duplicate, reinterpret, or modify:',
'• walls, partial walls, columns, headers, doorways, openings, pass-throughs, alcoves, niches, room separations',
'• ceilings, soffits, flooring, flooring direction, flooring transitions, trim, baseboards',
'• windows, doors, sliding doors, vents',
'• cabinetry, islands, countertops, appliances, fireplaces, built-ins',
'• chandeliers, pendant lights, recessed lights, sconces, ceiling fans, fixed focal points',
'Do NOT make any room, rear space, opening, alcove, or adjoining area appear larger, smaller, deeper, wider, more open, more enclosed, or more connected than in the original photograph. If any staging plan requires changing architecture or permanent fixtures, reject that plan and stage less.',
'IMMUTABILITY WINS over user intent, style, palette, semantic anchors, and furniture placement. LOCK ORIGINAL IMAGE IMMUTABILITY.',
'',
'MANDATORY FIXTURE INVENTORY & CONTRADICTION CHECK',
'Before staging, perform a fixture-inventory audit. List all visible permanent fixtures (cabinetry, chandeliers, fireplaces, ceiling fans, built-ins). Lock these fixtures as immutable.',
'If any proposed staging action deletes, conceals, duplicates, or adds fixtures, flag a violation: "IMMUTABILITY CONTRADICTION DETECTED." Reject the staging plan and restage using only existing fixtures.',
'No new chandeliers, cabinets, or architectural features may be created. No existing fixtures may be removed or relocated. All staging must occur within the immutable architectural boundaries.',
'',
'RENDER-PHASE IMMUTABILITY VERIFICATION (RPIV)',
'Before finalizing ANY virtual staging render, compare staged output to the original photograph. Confirm all permanent architectural fixtures remain EXACTLY as photographed:',
'• Cabinetry',
'• Partial walls',
'• Columns, headers, soffits',
'• Fireplaces',
'• Chandeliers, pendant lights, recessed lights',
'• Ceiling fans',
'• Built-ins',
'• Flooring direction and transitions',
'If ANY discrepancy is detected: Flag "RENDER-PHASE IMMUTABILITY VIOLATION." Reject the render. Restage using ONLY the original fixture inventory.',
'Mandatory render-phase checks:',
'• Cabinetry count and placement identical',
'• No removed or concealed partial walls',
'• No hallucinated chandeliers or duplicated fixtures',
'• No architectural element altered for composition or symmetry',
'• No widening, narrowing, or reinterpretation of openings',
'• Only user-specified rooms and zones staged; all others left vacant',
'• Design style and palette applied only from the Design Style & Palette block below',
'Output requirement: State "All permanent fixtures preserved exactly as photographed. AB-723 compliant."',
'',
'TASK',
'Analyze the uploaded room photograph and identify all functional furnishing Rooms and Zones based solely on pre-existing visible architecture, fixtures, openings, windows, cabinetry, fireplaces, built-ins, ceiling features, and circulation paths — before placing any furnishings.',
'',
'CAMERA ORIGIN ANALYSIS',
'Determine the physical location of the camera within the photographed home.',
'Do NOT assume the camera is standing in a hallway simply because the foreground appears empty.',
'If the foreground contains a large uninterrupted floor area without permanent architectural barriers, determine whether the camera is positioned inside a functional room whose boundaries extend beyond the visible image.',
'Possible room types include: Living Room, Dining Zone, Kitchen, Office, Bedroom, Flex Room, Entry.',
'If the camera is positioned inside a functional room:',
'• Lock that room.',
'• Treat the visible foreground as belonging to that room.',
'• Assume furnishings may begin outside the image frame.',
'• Preserve realistic room proportions.',
'• Do NOT compress furnishings into the mid-ground simply because the camera occupies part of the room.',
'LOCK CAMERA ORIGIN BEFORE CONTINUING.',
'',
'ZONE IDENTIFICATION RULES',
'Identify each functional furnishing zone visible in the image according to architectural definitions:',
'• Living Room: two or more connected walls',
'• Formal Dining Room: two or more connected walls',
'• Dining Zone: zero or one wall, positioned in open space',
'• Kitchen: cabinets, countertops, appliances, island base cabinets',
'• Bar Stool Rule: Place stools ONLY on an island face where a countertop overhang is clearly and unambiguously visible in the original photograph. If no overhang is photographically confirmed on any island face, do NOT place stools. Do NOT infer, construct, or assume a seating overhang that is not visible in the original photograph. Open floor clearance adjacent to an island face is NOT evidence of a seating overhang.',
'• Family Room / Primary Bedroom / Loft / Flex Room: two or more connected walls',
'• Flex Room examples: Office, Formal Dining Room, Media Room, Play Room, Music Room',
'• Circulation Zones: Entry = light décor only; Hallway = maintain clear path, no furniture',
'',
'ZONE BOUNDARIES',
'Determine zone boundaries using architectural cues: walls, partial walls, openings, doorways, windows, sliding doors, fireplaces, ceiling changes, chandeliers, pendant lighting, ceiling fans, built-ins, hallways, and circulation paths.',
'',
'SPATIAL ACCURACY RULES',
'Respect the exact perspective, geometry, scale, camera angle, and architectural proportions shown in the original photograph. Zone boundaries must align with actual architectural features.',
'Always use these zone anchors whenever present:',
'• Chandelier — LOCKS Dining Zone. If chandelier is pre-existing, lock this as the Dining Zone; place table and chairs centered directly below.',
'• Fireplace — LOCKS Living Zone. Lock the fireplace wall and connected walls as the Living Zone.',
'• Ceiling Fan — typically defines and reinforces Living Zones.',
'',
'ROOMS AND ZONES TO STAGE — USER SELECTIONS',
'Your job is to identify, find, and stage ONLY the Rooms and Zones listed below. If a zone is not listed, that area must be left completely vacant.',
'',
'Find and stage: {{room_assignment_variables}}',
'',
'MANDATORY ZONE COVERAGE — NO SILENT OMISSIONS',
'Every zone listed above MUST receive appropriate furniture placement. This requirement applies EQUALLY to zones with a fixture anchor (chandelier, fireplace, ceiling fan) and zones with NO fixture anchor.',
'The absence of a chandelier, fireplace, or other fixture anchor is NEVER grounds to leave a listed zone vacant, sparse, or under-furnished. Fixture anchors are used ONLY to resolve WHERE a zone sits and to settle placement conflicts between zones — they are not a precondition for a listed zone to be furnished at all.',
'If a listed zone has no fixture anchor, identify its location using the ZONE IDENTIFICATION RULES and ZONE BOUNDARIES above (wall count, open-space position, sightline, adjacency to other identified zones, circulation paths) and furnish it fully to the same standard as an anchored zone.',
'Treat every zone name in the list above as an independent, non-optional staging requirement. Every listed zone must be furnished at the position given by its anchor instruction, exactly as specified. Do not relocate a zone to a different wall, fixture, or position than the one given because another position seems visually easier, more balanced, or more open to furnish. The anchor is the position, not a suggestion to weigh against your own read of the room.',
'',
'CIRCULATION-ZONE FRAME BEHAVIOR',
'Some zones require open clearance on every side to function -- most commonly a dining or breakfast grouping, which needs room to pull chairs out and walk fully around it. A zone with this requirement is never wall-anchored, and by definition cannot be composed to show its full extent with open space on all sides visible AND remain photographically accurate to a real camera position -- one or the other has to give.',
'When a circulation-dependent zone anchor places it in the foreground (South frame edge), or at the left (West) or right (East) frame edge, render it exactly as a real photograph taken from this camera position would show it: if the grouping extends beyond what the lens would have captured from here, let it be cropped by that frame edge. Do not compress, shrink, reposition, or reorient the grouping to force the whole thing into frame -- an accurate real estate photograph routinely shows a foreground dining set partially cut off by the frame, and that is the correct, expected result here, not an error to avoid.',
'Cropping is permitted ONLY at the West, South, and East frame edges -- never at the North (background) edge. There is no camera-position reason a real photograph would cut a zone off at the far/background wall the way it legitimately would near-lens; a zone appearing cropped at the North edge would look like broken architecture, not photographic framing, and must not happen. If a circulation-dependent zone is anchored toward the background of the frame, compose it fully within the visible room instead.',
'This applies only to circulation-dependent zones (no wall anchor, open space on all sides required). Wall-anchored zones such as a living room seating group should remain fully composed within the frame as normal -- they do not have this clearance requirement and cropping them is not called for.',
'',
'NON-CREATION CHANDELIER RULES',
'Do NOT add any chandelier, pendant cluster, or decorative overhead fixture to the staged render unless one already exists in the original photograph.',
'Do NOT add a chandelier that does not exist in the original photograph. Existing chandeliers visible in the original photo ARE recognized as zone anchors and ALWAYS lock the Dining Zone directly below them.',
'If no chandelier is visible in the original photo, none may appear in the render.',
'',
'If a chandelier exists in the original photograph:',
'• It locks the Dining Zone (centered table and chairs directly below)',
'• It may not be repositioned, resized, duplicated, or removed in the render',
'• It must not visually block the primary furniture arrangement from camera origin; if so, adjust only camera framing — never the fixture',
'',
'FIXTURE–FURNITURE CONTRADICTION ENFORCEMENT',
'Before placing furniture, perform a mandatory contradiction check between pre-existing architectural fixtures and proposed furniture placement. Permanent fixtures ALWAYS outrank furniture. If furniture placement contradicts fixture-anchored zone identity, reject and flag the contradiction.',
'',
'Chandelier Contradictions — A chandelier in open space ALWAYS locks the Dining Zone. Contradiction exists if:',
'• Sofa or living furniture placed under chandelier',
'• Dining table not centered under chandelier',
'• Dining table placed near fireplace or under ceiling fan',
'→ Flag DINING FIXTURE CONTRADICTION DETECTED → Reject → Reassign → Restage.',
'',
'Fireplace Contradictions — A fireplace ALWAYS locks the Living Zone. Contradiction exists if:',
'• Dining table adjacent to fireplace',
'• Sofa not oriented toward fireplace',
'• Living seating placed under chandelier instead of fireplace',
'→ Flag LIVING FIXTURE CONTRADICTION DETECTED → Reject → Reassign → Restage.',
'',
'Ceiling Fan Contradictions — Ceiling fans reinforce Living Zones. Contradiction exists if:',
'• Dining table placed under ceiling fan',
'• Living seating placed under chandelier instead of fan',
'→ Flag CEILING FAN CONTRADICTION DETECTED → Reject → Reassign → Restage.',
'',
'Fixture Priority Hierarchy — resolve contradictions in this order:',
'1. Fireplace',
'2. Chandelier',
'3. Ceiling Fan',
'4. Kitchen Fixtures (island, cabinetry) — define the Kitchen zone boundary only. Kitchen fixtures do NOT lock, define, or influence the Dining Zone or Living Zone. Adjacent zone identity is determined solely by fixture anchors (items 1–3) and wall-count rules.',
'5. Furniture',
'Furniture NEVER outranks fixtures.',
'',
'When contradiction detected:',
'• State contradiction explicitly',
'• Reject incorrect furniture interpretation',
'• Reclassify zones based only on fixtures',
'• Restage correctly',
'• Ignore user intent if conflicting with fixture hierarchy',
'',
'DESIGN STYLE & PALETTE',
'{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}',
'',
'OUTPUT REQUIREMENTS',
'Do not alter architecture.',
'ZONE COVERAGE VERIFICATION — Before finalizing the render, confirm every zone named in "Find and stage" above contains appropriate furniture. If any listed zone is empty, sparse, or missing its primary furniture pieces, flag "ZONE COVERAGE VIOLATION," return to that zone, and place furniture using the architectural cues available — even without a fixture anchor — before finalizing.',
'AB-723 COMPLIANCE — Planning and visualization only. Do not alter, remove, relocate, resize, conceal, or modify any architectural element including walls, windows, doors, cabinetry, fireplaces, flooring, ceilings, lighting fixtures, appliances, or built-in features. All architectural elements must remain exactly as photographed.',
'State: "All permanent fixtures preserved exactly as photographed. AB-723 compliant."'
].join('\n');

const OPEN_PLAN_ZONE_LABELS = { kitchen: 'Kitchen', dining: 'Dining Zone', living: 'Living Room', family: 'Family Room', flex: 'Flex Room' };

const STYLE_LABELS = {
  'organicmodern':'Organic Modern','transitional':'Transitional','contemporary':'Contemporary',
  'modern':'Modern','scandinavian':'Scandinavian','minimalist':'Minimalist',
  'coastal':'Coastal','farmhouse':'Farmhouse','midcenturymodern':'Mid-Century Modern',
  'industrial':'Industrial','bohemian':'Bohemian','traditional':'Traditional',
  'japandi':'Japandi','warmminimalist':'Warm Minimalist','luxemodern':'Luxe Modern',
  'artdeco':'Art Deco','mediterranean':'Mediterranean','rustic':'Rustic',
  'grandmillennial':'Grand Millennial','wabi_sabi':'Wabi Sabi',
};
const PALETTE_TONES = {
  'Warm Neutrals':    'warm cream, taupe, and honey tones',
  'Bright Airy':      'soft white, pale sage, and warm wood tones',
  'Soft Luxury':      'blue, gray, and champagne tones',
  'Cool Gray':        'cool gray, slate, and white tones',
  'Earth Tones':      'terracotta, rust, and warm brown tones',
  'Bold Contrast':    'black, white, and bold accent tones',
  'Coastal Blue':     'ocean blue, sandy neutral, and white tones',
  'Sage Green':       'sage green, warm white, and natural wood tones',
  'Jewel Tones':      'emerald, sapphire, and warm gold tones',
  'Desert Modern':    'sand, clay, and muted terracotta tones',
  'Moody Executive':  'charcoal, espresso, cognac leather, and dark walnut tones',
  'Organic Natural':  'linen, natural oak, matte black accents, and stone tones',
};

const STYLE_FURNITURE_VOCABULARY = {
  'Organic Modern': {
    sofa: [
      'a curved boucle sofa in warm ivory with rounded bolster arms',
      'a linen tuxedo-arm sofa in oatmeal with tapered light-wood legs',
      'a channel-tufted sofa in warm taupe performance fabric',
    ],
    coffeeTable: [
      'a live-edge walnut slab coffee table',
      'an organic-form white oak coffee table with a sculptural base',
      'a honed travertine coffee table with rounded edges',
    ],
    diningTable: [
      'a round white oak dining table with a pedestal base',
      'an organic-edge walnut dining table',
    ],
    diningChairs: [
      'woven rush-seat dining chairs with light wood frames',
      'curved boucle-upholstered dining chairs',
    ],
    accentChair: [
      'a sculptural rattan accent chair',
      'a low-profile boucle swivel chair in cream',
    ],
    areaRug: [
      'a jute-blend area rug with subtle texture',
      'a hand-knotted wool rug in undyed cream tones',
    ],
    woodTone: ['warm white oak', 'natural walnut', 'bleached ash'],
    metalFinish: ['brushed brass', 'matte black', 'warm bronze'],
    artwork: [
      'an abstract textured canvas in warm neutral tones',
      'a large-scale organic-form print in a simple wood frame',
      'a set of two small abstract earth-tone canvases grouped together',
    ],
    props: [
      'a stack of art books topped with a hand-thrown ceramic object on the coffee table',
      'a ceramic bowl and a woven-texture tray grouped on the console',
      'a small collection of organic-form ceramic vessels on a shelf',
    ],
    greenery: {
      small:  ['a small potted snake plant on a side table', 'a trailing pothos in a ceramic pot on a shelf'],
      medium: ['a mid-height fiddle leaf fig in a woven basket', 'olive branch stems in a ceramic vessel on the console'],
      large:  ['a large floor fiddle leaf fig in a concrete planter', 'a tall dried pampas arrangement in a floor vase'],
    },
  },
  'Transitional': {
    sofa: [
      'a tailored track-arm sofa with softly structured upholstery',
      'a refined shelter-arm sofa with balanced classic proportions',
      'a clean rolled-arm sofa with restrained traditional detailing',
    ],
    coffeeTable: [
      'a rectangular wood coffee table with refined detailing',
      'a stone-top coffee table with a simple dark metal base',
      'an upholstered ottoman-style coffee table with tailored edges',
    ],
    diningTable: [
      'an oval wood dining table with a refined pedestal base',
      'a rectangular dining table with clean traditional proportions',
    ],
    diningChairs: [
      'upholstered dining chairs with tailored backs and wood legs',
      'clean-lined wood dining chairs with lightly upholstered seats',
    ],
    accentChair: [
      'a tailored lounge chair with subtle traditional influence',
      'a compact upholstered barrel chair with refined proportions',
    ],
    areaRug: [
      'a low-contrast patterned wool rug with a timeless motif',
      'a textured neutral rug with restrained border detail',
    ],
    woodTone: ['medium walnut', 'warm oak', 'dark espresso'],
    metalFinish: ['aged brass', 'polished nickel', 'dark bronze'],
    artwork: [
      'a framed abstract print in muted tones with a classic wood or metal frame',
      'a botanical or landscape print in a refined frame',
      'a pair of matching framed prints hung symmetrically',
    ],
    props: [
      'a stack of hardcover books with a small decorative object on the coffee table',
      'a ceramic or glass vase with simple stems on the console',
      'a decorative tray with a candle and small object grouped together',
    ],
    greenery: {
      medium: ['a ficus or olive-style plant in a tailored planter'],
      large: ['a tall indoor tree in a simple architectural planter'],
    },
  },
  'Contemporary': {
    sofa: [
      'a streamlined low-profile sofa with crisp tailored upholstery',
      'a modular sofa with clean geometry and restrained seams',
      'a sculptural contemporary sofa with softened square forms',
    ],
    coffeeTable: [
      'a monolithic stone coffee table with clean geometry',
      'a slim wood-and-metal coffee table with architectural lines',
      'a nested pair of contemporary round tables in mixed materials',
    ],
    diningTable: [
      'a clean-lined rectangular dining table with an architectural base',
      'a round dining table with a simple sculptural pedestal',
    ],
    diningChairs: [
      'streamlined upholstered dining chairs with slim profiles',
      'molded contemporary dining chairs with refined upholstery',
    ],
    accentChair: [
      'a sculptural lounge chair with crisp contemporary geometry',
      'a low swivel chair with a clean upholstered shell',
    ],
    areaRug: [
      'a tonal wool rug with subtle linear texture',
      'a low-pile rug with restrained abstract pattern',
    ],
    woodTone: ['natural oak', 'smoked oak', 'dark walnut'],
    metalFinish: ['matte black', 'brushed nickel', 'soft brass'],
    artwork: [
      'a large-scale abstract canvas in a bold but restrained palette',
      'a graphic black-and-white photographic print in a slim frame',
      'an architectural line-art print in a minimal frame',
    ],
    props: [
      'a sculptural ceramic object on the coffee table',
      'a stack of design books with a geometric sculptural accent',
      'a simple glass or ceramic vessel with minimal stems',
    ],
    greenery: {
      small: ['a simple architectural plant in a minimal pot'],
      medium: ['a restrained indoor tree in a clean cylindrical planter'],
      large: ['a tall sculptural plant in a minimal floor planter'],
    },
  },
  'Luxe Modern': {
    sofa: [
      'a substantial low-profile sofa with deep tailored cushions',
      'a large sculptural sofa with premium textured upholstery',
      'a refined channel-detail sofa with generous proportions',
    ],
    coffeeTable: [
      'a substantial stone coffee table with a sculptural base',
      'a dark wood coffee table with architectural massing',
      'a refined mixed-material table combining stone and metal',
    ],
    diningTable: [
      'a substantial dining table with a stone or rich wood top and sculptural base',
      'an oversized oval dining table with premium material expression',
    ],
    diningChairs: [
      'fully upholstered dining chairs with substantial tailored profiles',
      'sculptural dining chairs with premium upholstery and refined frames',
    ],
    accentChair: [
      'a substantial sculptural lounge chair in premium upholstery',
      'a refined swivel chair with deep seat and tailored form',
    ],
    areaRug: [
      'a large hand-knotted rug with subtle tonal depth',
      'a plush textured rug with understated luxury character',
    ],
    woodTone: ['dark walnut', 'smoked oak', 'rich medium oak'],
    metalFinish: ['brushed brass', 'blackened bronze', 'polished nickel'],
    artwork: [
      'a large abstract canvas with metallic or tonal depth in a substantial frame',
      'a striking oversized art piece with rich color and texture',
      'a pair of large-scale abstract prints in premium frames',
    ],
    props: [
      'a stack of coffee-table art books topped with a polished stone or metal sculptural object',
      'a crystal or polished-stone bowl on the console',
      'a refined sculptural object paired with a textured vase',
    ],
    greenery: {
      small: ['a restrained luxury greenery arrangement in a stone or ceramic vessel'],
      medium: ['a mature indoor tree in a refined architectural planter'],
      large: ['a tall statement tree in an oversized premium planter'],
    },
  },
  'Japandi': {
    sofa: [
      'a low-profile sofa with restrained geometry and natural-fiber upholstery',
      'a simple tailored sofa with soft minimal detailing',
      'a compact sculptural sofa with quiet proportions and tactile upholstery',
    ],
    coffeeTable: [
      'a low solid-wood table with simple crafted form',
      'a stone or wood table with quiet organic geometry',
      'a minimal pedestal table with natural material expression',
    ],
    diningTable: [
      'a simple solid-wood dining table with restrained crafted form',
      'a round or oval wood table with quiet joinery-inspired detailing',
    ],
    diningChairs: [
      'minimal wood dining chairs with woven or upholstered seats',
      'clean crafted chairs with light visual weight and natural texture',
    ],
    accentChair: [
      'a low sculptural wood-frame lounge chair',
      'a minimal upholstered chair with quiet natural texture',
    ],
    areaRug: [
      'a quiet textured wool rug with minimal pattern',
      'a flatwoven natural-fiber rug with restrained texture',
    ],
    woodTone: ['light natural oak', 'medium warm oak', 'smoked ash'],
    metalFinish: ['matte black', 'dark bronze', 'restrained brushed metal'],
    artwork: [
      'a single restrained ink-wash or abstract print in a simple wood frame',
      'a small textile or fiber-art piece in muted natural tones',
      'a minimal botanical line print in a thin wood frame',
    ],
    props: [
      'a single ceramic vessel with a bare branch on the console',
      'a small stack of linen-bound books with one quiet object',
      'a simple stoneware bowl or tray, left mostly empty for negative space',
    ],
    greenery: {
      small: ['a restrained branch arrangement in a simple ceramic vessel'],
      medium: ['a sculptural green plant in a minimal natural-material planter'],
      large: ['a sparse indoor tree with an understated planter'],
    },
  },
  'Coastal': {
    sofa: [
      'a relaxed tailored sofa with casual natural-fiber upholstery',
      'a slipcovered sofa with clean contemporary proportions',
      'a comfortable track-arm sofa with light visual weight',
    ],
    coffeeTable: [
      'a light wood coffee table with relaxed crafted character',
      'a woven or wood table with casual West Coast texture',
      'a pale stone-top table with a simple natural base',
    ],
    diningTable: [
      'a light-toned wood dining table with relaxed proportions',
      'a round pedestal dining table with casual natural material character',
    ],
    diningChairs: [
      'woven-back dining chairs with clean wood frames',
      'light upholstered dining chairs with relaxed tailored forms',
    ],
    accentChair: [
      'a woven-frame lounge chair with relaxed upholstery',
      'a casual upholstered chair with light natural wood details',
    ],
    areaRug: [
      'a textured natural-fiber rug with soft pattern variation',
      'a light woven rug with relaxed coastal texture',
    ],
    woodTone: ['white oak', 'washed oak', 'natural ash'],
    metalFinish: ['soft brass', 'matte black', 'brushed nickel'],
    artwork: [
      'a loose abstract print in soft ocean-inspired tones',
      'a textured woven wall hanging',
      'a simple framed botanical or horizon-line print',
    ],
    props: [
      'a woven basket with a stack of linen throws nearby',
      'a ceramic or glass vessel with dried grasses on the console',
      'a stack of books with a piece of driftwood-inspired sculptural object',
    ],
    greenery: {
      small: ['a small leafy plant in a light ceramic pot'],
      medium: ['a casual olive-style plant in a woven or ceramic planter'],
      large: ['a tall airy indoor tree in a natural-texture planter'],
    },
  },
  'Mid-Century Modern': {
    sofa: [
      'a tailored low sofa with slim arms and tapered wood legs',
      'a structured sofa with clean 1950s-inspired proportions',
      'a compact bench-seat sofa with exposed wood base details',
    ],
    coffeeTable: [
      'an oval walnut coffee table with tapered legs',
      'a sculptural wood coffee table with period-inspired geometry',
      'a slim glass-and-wood coffee table with architectural lines',
    ],
    diningTable: [
      'a walnut dining table with tapered legs and clean period proportions',
      'a round wood pedestal table with mid-century architectural character',
    ],
    diningChairs: [
      'wood-frame dining chairs with sculpted backs and upholstered seats',
      'slim period-inspired dining chairs with tapered legs',
    ],
    accentChair: [
      'a sculptural wood-frame lounge chair with period-inspired upholstery',
      'a low lounge chair with tapered legs and tailored cushions',
    ],
    areaRug: [
      'a low-pile rug with restrained geometric pattern',
      'a textured rug with subtle period-inspired abstract design',
    ],
    woodTone: ['walnut', 'teak-inspired medium wood', 'warm oak'],
    metalFinish: ['aged brass', 'matte black', 'brushed steel'],
    artwork: [
      'a bold graphic abstract print in a slim walnut frame',
      'a period-inspired geometric print',
      'a starburst or sculptural wall object as an accent piece',
    ],
    props: [
      'a stack of vintage-inspired books with a ceramic sculptural object',
      'a walnut bowl or tray with a simple sculptural accent',
      'a ceramic vessel with sculptural dried branches',
    ],
    greenery: {
      small: ['a compact architectural plant in a simple ceramic pot'],
      medium: ['a rubber plant or similar upright green in a period-appropriate planter'],
      large: ['a tall sculptural indoor plant in a simple floor planter'],
    },
  },
  'Scandinavian': {
    sofa: [
      'a light-profile sofa with simple tailored cushions and slim legs',
      'a comfortable sofa with soft rounded corners and minimal detailing',
      'a compact upholstered sofa with clean functional proportions',
    ],
    coffeeTable: [
      'a simple pale wood coffee table with softened corners',
      'a round light-oak table with functional minimal geometry',
      'a compact nesting-table set in pale wood and restrained metal',
    ],
    diningTable: [
      'a light wood dining table with simple functional proportions',
      'a round pale-oak dining table with a clean pedestal or leg base',
    ],
    diningChairs: [
      'simple wood dining chairs with shaped backs and light upholstery',
      'clean functional chairs with pale wood frames and woven seats',
    ],
    accentChair: [
      'a light wood-frame lounge chair with soft upholstered cushions',
      'a compact sculptural chair with approachable proportions',
    ],
    areaRug: [
      'a soft wool rug with subtle texture and minimal pattern',
      'a flatwoven rug with restrained Nordic-inspired geometry',
    ],
    woodTone: ['pale oak', 'natural ash', 'light birch'],
    metalFinish: ['matte black', 'brushed steel', 'soft brass'],
    artwork: [
      'a simple abstract print in soft muted tones with a light wood frame',
      'a minimal line-art print',
      'a pair of small matching prints in light frames',
    ],
    props: [
      'a simple ceramic vase with a single stem on the console',
      'a stack of light-toned books with one small object',
      'a woven basket or tray kept simple and uncluttered',
    ],
    greenery: {
      small: ['a small leafy plant in a simple white or stoneware pot'],
      medium: ['a restrained green plant in a pale ceramic planter'],
      large: ['a tall airy plant in a simple light-toned planter'],
    },
  },
  'Mediterranean': {
    sofa: [
      'a relaxed sofa with softly sculpted profile and textured upholstery',
      'a substantial upholstered sofa with rounded Mediterranean-inspired form',
      'a clean contemporary sofa softened by tactile natural materials',
    ],
    coffeeTable: [
      'a stone or plaster-look coffee table with sculptural geometry',
      'a warm wood table with substantial handcrafted character',
      'an organic stone-top table with a simple architectural base',
    ],
    diningTable: [
      'a substantial wood dining table with softly rustic refined character',
      'a round stone or wood pedestal table with sculptural Mediterranean form',
    ],
    diningChairs: [
      'wood dining chairs with woven seats and refined handcrafted character',
      'upholstered dining chairs with softly rounded backs and warm material expression',
    ],
    accentChair: [
      'a sculptural lounge chair with woven or textured natural materials',
      'a rounded upholstered chair with warm handcrafted character',
    ],
    areaRug: [
      'a textured wool rug with subtle old-world pattern influence',
      'a natural woven rug with warm tactile character',
    ],
    woodTone: ['warm oak', 'aged walnut', 'medium natural wood'],
    metalFinish: ['aged brass', 'dark bronze', 'blackened iron'],
    artwork: [
      'a warm abstract print with earthy tones in a simple wood frame',
      'a textured woven or macrame wall hanging',
      'a landscape or coastal-inspired print with warm tones',
    ],
    props: [
      'a terracotta or stone vessel with dried branches on the console',
      'a stack of books with a hand-thrown ceramic object',
      'a woven tray with a simple decorative bowl',
    ],
    greenery: {
      small: ['an olive branch arrangement in a rustic-refined ceramic vessel'],
      medium: ['an olive-style tree in a textured planter'],
      large: ['a tall olive-style tree in a substantial plaster or ceramic planter'],
    },
  },
  'Farmhouse': {
    sofa: [
      'a comfortable tailored sofa with relaxed upholstery and clean traditional proportions',
      'a simple track-arm sofa with casual structured cushions',
      'a modern slipcovered sofa with restrained farmhouse character',
    ],
    coffeeTable: [
      'a solid wood coffee table with clean handcrafted detailing',
      'a simple plank-style table with refined rather than distressed finish',
      'a wood-and-metal coffee table with restrained farmhouse character',
    ],
    diningTable: [
      'a substantial wood dining table with clean farmhouse proportions',
      'a round wood pedestal table with simple traditional character',
    ],
    diningChairs: [
      'clean spindle-back dining chairs with modern proportions',
      'upholstered wood-frame chairs with casual tailored character',
    ],
    accentChair: [
      'a comfortable linen-upholstered chair with simple wood details',
      'a clean wing-inspired chair with restrained traditional form',
    ],
    areaRug: [
      'a textured wool or jute-blend rug with subtle pattern',
      'a low-contrast vintage-inspired rug with modern restraint',
    ],
    woodTone: ['natural oak', 'warm medium wood', 'weathered-look oak without distressing'],
    metalFinish: ['matte black', 'aged brass', 'dark bronze'],
    artwork: [
      'a simple framed botanical or landscape print',
      'a modern abstract print with a clean simple frame',
      'a set of small matching prints grouped together',
    ],
    props: [
      'a stack of books with a simple ceramic or galvanized-metal object',
      'a woven basket or wood tray on the coffee table',
      'a simple ceramic pitcher or vessel with stems on the console',
    ],
    greenery: {
      small: ['a simple potted herb or leafy plant in a ceramic vessel'],
      medium: ['a leafy indoor plant in a woven or ceramic planter'],
      large: ['a tall indoor tree in a simple natural-texture planter'],
    },
  },
  'Traditional': {
    sofa: [
      'a tailored sofa with classic proportions and restrained rolled arms',
      'a refined upholstered sofa with subtle traditional detailing',
      'a structured sofa with timeless silhouette and elegant upholstery',
    ],
    coffeeTable: [
      'a refined wood coffee table with classic proportions and subtle detailing',
      'a stone-top table with traditional-inspired base and restrained ornament',
      'an upholstered ottoman table with tailored classic detailing',
    ],
    diningTable: [
      'a classic wood dining table with refined traditional proportions',
      'an oval pedestal dining table with elegant restrained detailing',
    ],
    diningChairs: [
      'upholstered dining chairs with classic wood frames and tailored backs',
      'refined wood dining chairs with restrained traditional detailing',
    ],
    accentChair: [
      'a classic lounge chair with tailored upholstery and refined proportions',
      'a restrained wing chair with modernized traditional detailing',
    ],
    areaRug: [
      'a wool rug with subtle traditional pattern and controlled contrast',
      'a refined low-contrast Persian-inspired rug',
    ],
    woodTone: ['medium walnut', 'mahogany-toned wood', 'warm dark oak'],
    metalFinish: ['aged brass', 'polished nickel', 'dark bronze'],
    artwork: [
      'a classic framed landscape or still-life print',
      'a refined abstract print in a traditional wood frame',
      'a pair of matching framed prints hung symmetrically above the sofa',
    ],
    props: [
      'a stack of leather-bound books with a small brass or porcelain object',
      'a crystal or porcelain vase with simple stems on the console',
      'a decorative tray with a candle and a small refined object',
    ],
    greenery: {
      small: ['a classic leafy plant or floral-greenery arrangement in a refined vessel'],
      medium: ['a formal indoor plant in a classic ceramic planter'],
      large: ['a tall indoor tree in an understated traditional planter'],
    },
  },
  'Art Deco': {
    sofa: [
      'a tailored sofa with gently curved geometry and refined channel detailing',
      'a sculptural sofa with elegant 1930s-inspired proportions',
      'a clean tuxedo sofa with subtle glamorous detailing',
    ],
    coffeeTable: [
      'a geometric stone-and-metal coffee table with refined Deco influence',
      'a dark wood table with stepped or rounded architectural geometry',
      'a glass-top table with elegant metal framework and restrained glamour',
    ],
    diningTable: [
      'a round or oval dining table with sculptural geometric base',
      'a dark wood dining table with polished architectural proportions',
    ],
    diningChairs: [
      'upholstered dining chairs with curved backs and elegant slim profiles',
      'tailored chairs with subtle channel detail and refined metal or wood accents',
    ],
    accentChair: [
      'a curved lounge chair with refined channel upholstery',
      'a sculptural barrel chair with restrained Deco influence',
    ],
    areaRug: [
      'a low-pile rug with subtle geometric Deco pattern',
      'a tonal rug with restrained fan or linear geometry',
    ],
    woodTone: ['dark walnut', 'ebonized wood', 'rich medium walnut'],
    metalFinish: ['brushed brass', 'polished nickel', 'blackened metal'],
    artwork: [
      'a bold geometric abstract print in a polished metal frame',
      'a striking Deco-inspired graphic print with elegant contrast',
      'a mirrored or metallic-accented wall art piece',
    ],
    props: [
      'a polished metal or mirrored tray with a sculptural object',
      'a stack of books with a lacquered or glass sculptural accent',
      'a crystal or glass vessel with a bold sculptural stem arrangement',
    ],
    greenery: {
      small: ['a sculptural leaf arrangement in a geometric vessel'],
      medium: ['an architectural plant in a refined metallic or ceramic planter'],
      large: ['a tall statement plant in an elegant geometric floor planter'],
    },
  },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStringToSeed(str) {
  let h = 0;
  const s = String(str || 'default-seed');
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function pickFurnitureProfile(styleLabel, projectSeedStr) {
  const pool = STYLE_FURNITURE_VOCABULARY[styleLabel];
  if (!pool) return null;
  const rand = mulberry32(hashStringToSeed(styleLabel + '::' + (projectSeedStr || 'no-project')));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  return {
    sofa: pick(pool.sofa),
    coffeeTable: pick(pool.coffeeTable),
    diningTable: pick(pool.diningTable),
    diningChairs: pick(pool.diningChairs),
    accentChair: pick(pool.accentChair),
    areaRug: pick(pool.areaRug),
    woodTone: pick(pool.woodTone),
    metalFinish: pick(pool.metalFinish),
  };
}

const ROOM_SIZE_TIER = {
  'primary bedroom': 'medium', 'bedroom': 'small', 'office': 'small', 'flex room': 'small',
  'great room': 'large', 'living room': 'medium', 'family room': 'medium',
  'kitchen-dining': 'large', 'dining room': 'medium', 'loft': 'medium', 'sitting area': 'small',
};
function pickGreenery(styleLabel, projectSeedStr, roomName) {
  const pool = STYLE_FURNITURE_VOCABULARY[styleLabel];
  if (!pool || !pool.greenery) return null;
  const tier = ROOM_SIZE_TIER[(roomName || '').toLowerCase().trim()] || 'medium';
  const options = pool.greenery[tier] || pool.greenery.medium;
  if (!options || !options.length) return null;
  const rand = mulberry32(hashStringToSeed(styleLabel + '::' + (projectSeedStr || 'no-project') + '::' + (roomName || '') + '::greenery'));
  return options[Math.floor(rand() * options.length)];
}

function pickArtworkAndProps(styleLabel, projectSeedStr, roomName) {
  const pool = STYLE_FURNITURE_VOCABULARY[styleLabel];
  if (!pool || !pool.artwork || !pool.props) return null;
  const rand = mulberry32(hashStringToSeed(styleLabel + '::' + (projectSeedStr || 'no-project') + '::' + (roomName || '') + '::artprops'));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  return { artwork: pick(pool.artwork), props: pick(pool.props) };
}

function buildRoomAssignmentVariable({ zoneList, flexNote, roomName, isOpenPlan, roomAssignmentText }) {
  // Vision-produced override (analyze-open-plan-zones.js) -- the rich,
  // per-zone anchor text validated this session (e.g. "Kitchen: Anchor:
  // island.\nLiving Room: Anchor: fireplace wall..."). Used verbatim when
  // present; this is what actually gets zone placement right on the first
  // pass, versus the plain comma-joined label list below, which was never
  // enough on its own for anchor-dependent placement.
  if (isOpenPlan && roomAssignmentText && roomAssignmentText.trim()) {
    return roomAssignmentText.trim();
  }
  if (!isOpenPlan) return roomName || 'this room';
  if (!zoneList || !zoneList.length) return roomName || 'this room';
  const names = zoneList.map(z => {
    const zo = OPEN_PLAN_ZONE_LABELS[z] || z;
    return (z === 'flex' && flexNote) ? `${flexNote} (Flex Room)` : zo;
  });
  return names.join(', ');
}

function buildDesignDnaVariable({ style, palette, buyerProfile, desiredFeeling, stagingLevel, furnishingsDNA, projectId, roomName }) {
  const parts = [];
  if (style)           parts.push('Design Style: ' + style);
  if (palette)         parts.push('Color Palette: ' + (PALETTE_TONES[palette] || palette));
  if (buyerProfile)    parts.push('Buyer Profile: ' + buyerProfile);
  if (desiredFeeling)  parts.push('Desired Feeling: ' + desiredFeeling);
  if (stagingLevel)    parts.push('Staging Level: ' + stagingLevel);
  let dnaText = parts.join('. ') + (parts.length ? '.' : '');

  const profile = style ? pickFurnitureProfile(style, projectId) : null;
  if (profile) {
    const greenery = pickGreenery(style, projectId, roomName);
    const artProps = pickArtworkAndProps(style, projectId, roomName);
    const profileParts = [
      'Sofa direction: ' + profile.sofa + '.',
      'Coffee-table direction: ' + profile.coffeeTable + '.',
      'Dining-table direction: ' + profile.diningTable + '.',
      'Dining-chair direction: ' + profile.diningChairs + '.',
      'Accent-chair direction: ' + profile.accentChair + '.',
      'Area-rug direction: ' + profile.areaRug + '.',
      'Wood-tone direction: ' + profile.woodTone + '.',
      'Metal-finish direction: ' + profile.metalFinish + '.',
    ];
    if (greenery) profileParts.push('Greenery direction: ' + greenery + '.');
    if (artProps) {
      profileParts.push('Wall-art direction: ' + artProps.artwork + '.');
      profileParts.push('Styling-accessories direction: ' + artProps.props + '.');
    }
    dnaText += '\n\nSTYLE FURNISHINGS DNA FOR THIS PROJECT (use as a design vocabulary, not a literal furniture catalog): ' +
      'Keep the selected style recognizable, but choose the exact furniture geometry, scale, upholstery, materials, artwork, and accessory mix that best fits this specific room and its circulation. ' +
      'Variation within the style is encouraged — wall art and styling accessories should differ from room to room, not repeat the same piece throughout the home. Do not alter permanent architecture or fixed finishes to accommodate the furnishings. ' +
      profileParts.join(' ');
  }

  if (furnishingsDNA) {
    const f = furnishingsDNA;
    const furnishingParts = [];
    if (f.continuityPrompt) furnishingParts.push(f.continuityPrompt);
    else {
      if (f.sofa) furnishingParts.push('Sofa: ' + f.sofa + '.');
      if (f.woodTones) furnishingParts.push('Wood tones: ' + f.woodTones + '.');
      if (f.metalFinishes) furnishingParts.push('Metal finishes: ' + f.metalFinishes + '.');
      if (f.colorPalette) furnishingParts.push('Palette: ' + (Array.isArray(f.colorPalette) ? f.colorPalette.join(', ') : f.colorPalette) + '.');
    }
    if (furnishingParts.length) {
      dnaText += '\n\nMATCH ESTABLISHED FURNISHINGS (from a previously staged room in this project): ' + furnishingParts.join(' ');
    }
  }
  return dnaText;
}

function assembleSpatialZonePrompt({ zones, dna }) {
  const roomAssignmentValue = buildRoomAssignmentVariable(zones || {});
  const designDnaValue = buildDesignDnaVariable({ ...(dna || {}), roomName: (zones || {}).roomName });
  return SPATIAL_ZONE_TEMPLATE
    .replace(/\{\{room_assignment_variables\}\}(?: go here)?/, roomAssignmentValue)
    .replace('{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}', designDnaValue);
}

module.exports = {
  SPATIAL_ZONE_TEMPLATE,
  OPEN_PLAN_ZONE_LABELS,
  STYLE_LABELS,
  PALETTE_TONES,
  STYLE_FURNITURE_VOCABULARY,
  pickFurnitureProfile,
  pickGreenery,
  pickArtworkAndProps,
  buildRoomAssignmentVariable,
  buildDesignDnaVariable,
  assembleSpatialZonePrompt,
};
