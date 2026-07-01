// spatial-zone-template.js — SHARED MODULE (not a Netlify function endpoint — no exports.handler)
//
// v1 Spatial Scene Compiler template (Pass 0-6), replacing the Phase 6.2 SPATIAL ZONE
// ANALYSIS template. Required by both group-spatial-read.js (Multi-Angle Group Stage, if
// revived) and stage-vacant-prompt.js (single-room Vacant Stage + Clean+Stage step 2), so
// the exact same template/assembler logic powers every staging prompt in the app — no
// per-file duplicate copies that can silently drift apart (this has already caused
// multiple production bugs when it happened with other functions).
//
// Two variable slots: {{room_assignment_variables}} and the Design DNA block (style,
// palette, buyer/feeling/staging-level, plus a per-project Furniture Profile drawn from
// STYLE_FURNITURE_VOCABULARY, plus captured furnishingsDNA continuity when present).
// GPT Image 2 does its own spatial/anchor reasoning — no Haiku description layer, no
// per-zone hand-written furniture scripts. The user's own zone selections are the only
// "translation" — everything else is the fixed template text below, verbatim.

const SPATIAL_ZONE_TEMPLATE = [
'SPATIAL ZONE ANALYSIS MODE',
'',
'PRIMARY ROLE: You are an architectural space planning analyst specializing in residential interiors.',
'SECONDARY ROLE: You are a professional luxury real estate interior designer, home stager, and architectural photographer.',
'',
'═══════════════════════════════════════════════════════',
'SPATIAL EXECUTION ENGINE (EXPERIMENTAL)',
'═══════════════════════════════════════════════════════',
'Before generating, staging, or rendering any furniture, complete each Spatial Pass in the order shown below.',
'Do not skip, merge, reinterpret, or reorder any pass.',
'Each completed pass establishes a locked spatial model that must be preserved throughout the remaining passes.',
'',
'═══════════════════════════════════════════════════════',
'PASS 0 — USER INTENT LOCK',
'═══════════════════════════════════════════════════════',
'The user has requested that only specific room zones be virtually staged.',
'Requested Zones: {{room_assignment_variables}}',
'Only these requested zones may receive furniture.',
'All other identified room zones exist only to establish correct spatial relationships and architectural context.',
'Do NOT stage any room simply because it is confidently identified.',
'Do NOT stage any room solely because a semantic anchor exists.',
'Room identification does NOT authorize furniture placement.',
'Only the user determines which rooms will be staged.',
'LOCK USER INTENT BEFORE CONTINUING.',
'',
'═══════════════════════════════════════════════════════',
'PASS 1 — CAMERA ORIGIN ANALYSIS',
'═══════════════════════════════════════════════════════',
'Determine the physical location of the camera within the photographed home.',
'Do NOT assume the camera is standing in a hallway or circulation path simply because the foreground appears empty.',
'If the foreground contains a large uninterrupted floor area without permanent architectural barriers (walls, cabinetry, fireplaces, built-ins, windows, doors, etc.), determine whether the camera is positioned inside a functional room whose boundaries extend beyond the visible image.',
'Possible room types include:',
'• Living Room',
'• Dining Room',
'• Breakfast Nook',
'• Kitchen',
'• Office',
'• Bedroom',
'• Flex Room',
'• Entry',
'If the camera is positioned inside a functional room:',
'✓ Lock that room.',
'✓ Treat the visible foreground as belonging to that room.',
'✓ Assume furnishings may naturally begin outside the image frame.',
'✓ Preserve realistic room proportions.',
'✓ Do NOT compress furnishings into the midground simply because the camera occupies part of the room.',
'The photograph represents only a cropped portion of a larger architectural space.',
'LOCK CAMERA ORIGIN BEFORE CONTINUING.',
'',
'═══════════════════════════════════════════════════════',
'PASS 2 — ROOM ZONE IDENTIFICATION',
'═══════════════════════════════════════════════════════',
'Using only permanent architectural features, identify every functional room visible.',
'Use only:',
'• Walls',
'• Partial walls',
'• Openings',
'• Doorways',
'• Cabinetry',
'• Kitchen Islands',
'• Fireplaces',
'• Built-ins',
'• Ceiling transitions',
'• Windows',
'• Sliding Glass Doors',
'• Hallways',
'• Major circulation paths',
'Furniture does not define room ownership.',
'Identify all functional room zones before placing furniture.',
'LOCK ALL ROOM ZONES BEFORE CONTINUING.',
'',
'═══════════════════════════════════════════════════════',
'PASS 3 — ROOM BOUNDARY ANALYSIS',
'═══════════════════════════════════════════════════════',
'Determine the architectural footprint of every identified room.',
'Room ownership follows architecture rather than open floor area.',
'Adjacent rooms may visually connect but shall never share the same floor ownership.',
'Do not expand one room into another simply because no wall separates them.',
'Open-plan homes still contain separate functional rooms.',
'LOCK ALL ROOM BOUNDARIES BEFORE CONTINUING.',
'',
'═══════════════════════════════════════════════════════',
'PASS 4 — SEMANTIC ANCHOR CONFIRMATION',
'═══════════════════════════════════════════════════════',
'After room ownership has been established, evaluate architectural and semantic anchors.',
'Semantic anchors increase confidence.',
'Semantic anchors do NOT establish room ownership.',
'Examples:',
'• Fireplaces strongly confirm Living Rooms.',
'• Chandeliers strongly confirm Dining Rooms.',
'• Ceiling Fans commonly confirm Living Rooms.',
'• Pendant Lights commonly confirm Seating or Gathering Areas.',
'If a semantic anchor conflicts with the previously locked Camera Origin or Room Boundaries, preserve the locked spatial model.',
'Camera Origin and Architecture always take precedence over Semantic Anchors.',
'LOCK ALL SEMANTIC ANCHORS BEFORE CONTINUING.',
'',
'═══════════════════════════════════════════════════════',
'PASS 5 — ZONE BEHAVIOR LOCKS',
'═══════════════════════════════════════════════════════',
'After Camera Origin, Room Identification, Room Boundaries, and Semantic Anchors have been locked, classify the behavioral purpose of every identified zone before assigning furniture.',
'Every architectural zone belongs to one of four behavior classes.',
'',
'────────────────────────────────────────',
'CLASS 1 — OCCUPIABLE ZONES',
'────────────────────────────────────────',
'Examples:',
'• Living Room',
'• Great Room',
'• Family Room',
'• Dining Room',
'• Bedroom',
'• Office',
'• Media Room',
'• Flex Room',
'Purpose: These zones are intended for furniture occupancy. Full furniture placement is permitted.',
'',
'────────────────────────────────────────',
'CLASS 2 — FUNCTIONAL ZONES',
'────────────────────────────────────────',
'Examples:',
'• Kitchen',
'• Pantry',
'• Laundry',
'• Mudroom',
"Purpose: These zones support household functions. Only furniture appropriate to the room's intended function may be added. Never convert a Functional Zone into a seating area.",
'',
'────────────────────────────────────────',
'CLASS 3 — CIRCULATION ZONES',
'────────────────────────────────────────',
'Examples:',
'• Hallways',
'• Entry Corridors',
'• Passageways',
'• Room Connectors',
'• Primary Walkways',
'Purpose: These zones exist solely for movement between rooms. Maintain completely unobstructed floor circulation. No floor-standing furniture may occupy these spaces.',
'DO NOT place:',
'• Floor plants',
'• Benches',
'• Ottomans',
'• Bookcases',
'• Accent cabinets',
'• Console tables',
'• Floor lamps',
'• Chairs',
'• Side tables',
'Wall-mounted decor IS permitted. Examples: ✓ Artwork ✓ Mirrors ✓ Existing wall sconces',
'The floor of a Circulation Zone must remain clear.',
'',
'────────────────────────────────────────',
'CLASS 4 — ARCHITECTURAL BUFFER ZONES',
'────────────────────────────────────────',
'Examples:',
'• Fireplace clearances',
'• Door swings',
'• Sliding door clearances',
'• Island circulation',
'• Appliance access',
'• Major traffic intersections',
'Purpose: Maintain clear architectural function. Furniture shall never obstruct these areas.',
'',
'═══════════════════════════════════════════════════════',
'BEHAVIOR LOCK',
'═══════════════════════════════════════════════════════',
'Once every zone has been assigned a behavior class:',
'LOCK all Zone Behaviors.',
'Furniture assignment must obey both:',
'• Locked Room Boundaries',
'AND',
'• Locked Zone Behaviors.',
'Behavior classification overrides available empty floor space.',
'Empty floor does NOT imply furnishable space.',
'Proceed to furniture assignment only after all Zone Behaviors are locked.',
'',
'═══════════════════════════════════════════════════════',
'PASS 6 — FURNITURE ASSIGNMENT',
'═══════════════════════════════════════════════════════',
'Only after all previous passes have completed:',
'Assign furniture only to the User Requested Zones.',
'Furniture must remain inside the previously locked room boundaries.',
'Large furniture groupings shall not expand into adjacent rooms simply because additional floor area is available.',
'When the camera occupies part of a room, furnishings may naturally extend beyond the visible image boundary.',
'Maintain realistic circulation paths between all room zones.',
'',
'═══════════════════════════════════════════════════════',
'ZONE RULES',
'═══════════════════════════════════════════════════════',
'IF a Chandelier exists, THEN center the Dining Table, Area Rug, and Dining Chairs beneath the chandelier.',
'IF no Chandelier exists, THEN determine the Dining Zone using the previously locked Room Boundaries and center the dining furniture appropriately.',
'────────────────────────────────────────',
'IF a Fireplace exists, THEN center the Living Room seating group on the fireplace. Center the Area Rug on the fireplace. Center the Coffee Table on the Area Rug.',
'────────────────────────────────────────',
'IF a Ceiling Fan exists, THEN center the primary seating group beneath the fan only when consistent with the previously locked Living Room boundaries.',
'────────────────────────────────────────',
'IF an Island Cabinet exists, Determine the primary function of each island face. Identify the Seating Face. LOCK THE SEATING FACE. Do NOT reinterpret this classification during rendering. IF the Seating Face is located on either island end, THEN do NOT place stools.',
'',
'═══════════════════════════════════════════════════════',
'DESIGN STYLE & PALETTE',
'═══════════════════════════════════════════════════════',
'{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}',
'',
'═══════════════════════════════════════════════════════',
'SPATIAL ACCURACY',
'═══════════════════════════════════════════════════════',
'Respect the exact perspective, geometry, scale, camera angle, and architectural proportions shown in the original photograph.',
'Preserve all architectural elements exactly as photographed.',
'Do not alter walls, windows, doors, cabinetry, fireplaces, flooring, ceilings, lighting fixtures, appliances, built-ins, or structural features.',
'All staging must remain fully compliant with California AB 723.',
'',
'═══════════════════════════════════════════════════════',
'AB 723 COMPLIANCE',
'═══════════════════════════════════════════════════════',
'This analysis is for planning and visualization purposes only.',
'Do not alter, remove, relocate, resize, conceal, or modify any architectural element including walls, windows, doors, cabinetry, fireplaces, flooring, ceilings, lighting fixtures, appliances, or built-in features.',
'All architectural elements must remain exactly as photographed.'
].join('\n');

const OPEN_PLAN_ZONE_LABELS = { kitchen: 'Kitchen', dining: 'Dining', living: 'Living Room', family: 'Family Room', flex: 'Flex Room' };

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
    .replace('{{room_assignment_variables}}', roomAssignmentValue)
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
