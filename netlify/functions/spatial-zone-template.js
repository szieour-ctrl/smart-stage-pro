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
'TASK',
'Analyze the uploaded room photograph and identify all functional furnishing Rooms and Zones based solely on pre-existing visible architecture, fixtures, openings, windows, cabinetry, fireplaces, built-ins, ceiling features, and circulation paths before placing furnishings.',
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
'Identify each functional furnishing zone visible in the image according to architectural definitions.',
'Examples and definitions include:',
'• Living Room: two or more connected walls',
'• Formal Dining Room: two or more connected walls',
'• Dining Zone: zero or one wall, positioned in open space',
'• Kitchen: cabinets, countertops, appliances, island base cabinets',
'• Family Room / Primary Bedroom / Loft / Flex Room: two or more connected walls',
'• Flex Room examples: Office, Formal Dining Room, Media Room, Play Room, Music Room',
'• Circulation Zones: Entry = light décor only; Hallway = maintain circular path, no furniture',
'',
'ZONE BOUNDARIES',
'Determine zone boundaries using architectural cues: walls, partial walls, openings, doorways, windows, sliding doors, fireplaces, kitchen islands, cabinetry, ceiling changes, chandeliers, pendant lighting, ceiling fans, built-ins, hallways, and circulation paths.',
'',
'SPATIAL ACCURACY RULES',
'Respect the exact perspective, geometry, scale, camera angle, and architectural proportions shown in the original photograph. Zone boundaries must align with actual architectural features.',
'Always use these zone anchors whenever present:',
'• Chandelier LOCKS Dining Zone. If chandelier is pre-existing, lock this as the Dining Zone; place table + chairs centered directly below.',
'• Fireplace LOCKS Living Zone. If fireplace is pre-existing, lock the fireplace wall and connected walls as the Living Zone.',
'• Ceiling Fans typically define Living Zones.',
'',
'Your job is to identify the find and stage only the Zones that are listed, if the zone is not listed the area is to be left vacant:',
'Find: {{room_assignment_variables}} go here',
'',
'FIXTURE–FURNITURE CONTRADICTION ENFORCEMENT',
'Before placing furniture, perform a mandatory contradiction check between pre-existing architectural fixtures and proposed furniture placement. Permanent fixtures ALWAYS outrank furniture. If furniture placement contradicts fixture-anchored zone identity, reject and flag the contradiction.',
'',
'Chandelier Contradictions',
'A chandelier in open space ALWAYS locks the Dining Zone. Contradiction exists if:',
'• Sofa or living furniture under chandelier',
'• Dining table not centered under chandelier',
'• Dining table near fireplace or under ceiling fan',
'→ Flag DINING FIXTURE CONTRADICTION DETECTED → Reject layout → Reassign Dining Zone → Restage correctly.',
'',
'Fireplace Contradictions',
'A fireplace ALWAYS locks the Living Zone. Contradiction exists if:',
'• Dining table adjacent to fireplace',
'• Sofa not oriented toward fireplace',
'• Living seating under chandelier',
'→ Flag LIVING FIXTURE CONTRADICTION DETECTED → Reject layout → Reassign Living Zone → Restage correctly.',
'',
'Ceiling Fan Contradictions',
'Ceiling fans reinforce Living Zones. Contradiction exists if:',
'• Dining table under ceiling fan',
'• Living seating under chandelier instead of fan',
'→ Flag CEILING FAN CONTRADICTION DETECTED → Reject layout → Reassign Living Zone → Restage accordingly.',
'',
'Fixture Priority Hierarchy',
'Resolve contradictions in this order:',
'1. Fireplace   2. Chandelier   3. Ceiling Fan   4. Kitchen Fixtures   5. Furniture',
'Furniture NEVER outranks fixtures.',
'',
'Mandatory Output Behavior',
'When contradiction detected:',
'• State contradiction explicitly',
'• Reject incorrect furniture interpretation',
'• Reclassify zones based only on fixtures',
'• Restage correctly',
'• Ignore user intent if conflicting',
'• Preserve Original Image Immutability',
'',
'DESIGN STYLE & PALETTE',
'{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}',
'',
'OUTPUT REQUIREMENTS',
'Do not alter architecture. AB 723 COMPLIANCE — Planning and visualization only.',
'Do not alter, remove, relocate, resize, conceal, or modify any architectural element including walls, windows, doors, cabinetry, fireplaces, flooring, ceilings, lighting fixtures, appliances, or built-ins. All architectural elements must remain exactly as photographed.'
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
    greenery: {
      small:  ['a small potted snake plant on a side table', 'a trailing pothos in a ceramic pot on a shelf'],
      medium: ['a mid-height fiddle leaf fig in a woven basket', 'olive branch stems in a ceramic vessel on the console'],
      large:  ['a large floor fiddle leaf fig in a concrete planter', 'a tall dried pampas arrangement in a floor vase'],
    },
  },
  // 'RH Luxury': { ... }           — not yet seeded, falls through to prior behavior
  // 'Contemporary': { ... }        — not yet seeded, falls through to prior behavior
  // 'Japandi': { ... }             — not yet seeded, falls through to prior behavior
  // 'Transitional': { ... }        — not yet seeded, falls through to prior behavior
  // 'Coastal California': { ... }  — not yet seeded, falls through to prior behavior
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

function buildRoomAssignmentVariable({ zoneList, flexNote, roomName, isOpenPlan }) {
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
  if (style)          parts.push('Design Style: ' + style);
  if (palette)        parts.push('Color Palette: ' + (PALETTE_TONES[palette] || palette));
  if (buyerProfile)   parts.push('Buyer Profile: ' + buyerProfile);
  if (desiredFeeling)  parts.push('Desired Feeling: ' + desiredFeeling);
  if (stagingLevel)    parts.push('Staging Level: ' + stagingLevel);
  let dnaText = parts.join('. ') + (parts.length ? '.' : '');

  const profile = style ? pickFurnitureProfile(style, projectId) : null;
  if (profile) {
    const greenery = pickGreenery(style, projectId, roomName);
    const profileParts = [
      'Sofa: ' + profile.sofa + '.',
      'Coffee table: ' + profile.coffeeTable + '.',
      'Dining table: ' + profile.diningTable + '.',
      'Dining chairs: ' + profile.diningChairs + '.',
      'Accent chair: ' + profile.accentChair + '.',
      'Area rug: ' + profile.areaRug + '.',
      'Wood tone: ' + profile.woodTone + '.',
      'Metal finish: ' + profile.metalFinish + '.',
    ];
    if (greenery) profileParts.push('Greenery: ' + greenery + '.');
    dnaText += '\n\nSPECIFIC FURNISHINGS FOR THIS PROJECT (use these exact pieces and materials — do not substitute generic alternatives, and do not repeat the same fabric or wood species across unrelated pieces): ' + profileParts.join(' ');
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
  buildRoomAssignmentVariable,
  buildDesignDnaVariable,
  assembleSpatialZonePrompt,
};
