// spatial-zone-template.js — SHARED MODULE (not a Netlify function endpoint — no exports.handler)
//
// Single source of truth for the Phase 6.2 SPATIAL ZONE ANALYSIS prompt template.
// Required by both group-spatial-read.js (Multi-Angle Group Stage, if revived) and
// stage-vacant-prompt.js (single-room Vacant Stage + Clean+Stage step 2), so the
// exact same template/assembler logic powers every staging prompt in the app —
// no per-file duplicate copies that can silently drift apart (this has already
// caused multiple production bugs when it happened with other functions).
//
// Two variable slots only: {{room_assignment_variables}} and the Design DNA block.
// GPT Image 2 does its own spatial/anchor reasoning — no Haiku description layer,
// no per-zone hand-written furniture scripts. The user's own zone selections are
// the only "translation" — everything else is the fixed template text below, verbatim.

const SPATIAL_ZONE_TEMPLATE = [
'SPATIAL ZONE ANALYSIS MODE',
'',
'PRIMARY ROLE: You are an architectural space planning analyst specializing in residential interiors.',
'SECONDARY ROLE: You are a professional luxury real estate interior designer, home stager, and architectural photographer.',
'',
'TASK',
'Analyze the uploaded room photograph and identify all functional furnishing zones based solely on the visible architecture, fixtures, openings, windows, cabinetry, fireplaces, built-ins, ceiling features, and circulation paths before you place furnishings',
'',
'ZONE IDENTIFICATION RULES',
'Identify each functional furnishing zone visible in the image.',
'Examples include:',
'• Living Room',
'• Dining Area',
'• Kitchen',
'• Breakfast Nook',
'• Flex Room',
'• Office',
'• Entry',
'• Loft',
'• Primary Bedroom',
'• Sitting Area',
'',
'Determine zone boundaries using architectural cues including:',
'• Walls',
'• Partial walls',
'• Openings',
'• Doorways',
'• Windows',
'• Sliding glass doors',
'• Fireplaces',
'• Kitchen islands',
'• Cabinetry',
'• Ceiling changes',
'• Chandeliers',
'• Pendant lighting',
'• Ceiling fans',
'• Built-ins',
'• Hallways',
'• Circulation paths',
'',
'SPATIAL ACCURACY RULES',
'Respect the exact perspective, geometry, scale, camera angle, and architectural proportions shown in the original photograph.',
'Zone boundaries must align with actual architectural features and not arbitrary visual estimates.',
'',
'Use zone anchors whenever present:',
'• Chandeliers typically define dining zones.',
'• Pendant lights typically define seating zones.',
'• Ceiling fans typically define living zones.',
'• Fireplaces typically define living zones',
'',
'Special rules for placing bar stool seating at cabinet islands:',
'Only place bar stools along the island edge that meets ALL of the following conditions:',
'• The countertop extends beyond the cabinet faces by approximately 10–18 inches (an overhang is visible).',
'• Cabinet doors, drawers, or panels terminate before the countertop edge — open knee space is visible beneath.',
'• The overhanging edge faces an adjacent open room (living room, dining room, great room) — NOT a kitchen work aisle, appliance wall, or perimeter counter run.',
'• The edge does not contain a sink, cooktop controls, dishwasher door, or appliance access that would prevent seating.',
'• If no edge meets all four conditions, do NOT place bar stools anywhere on the island.',
'• NEVER place bar stools on the side of the island facing kitchen work aisles, perimeter counters, or appliances.',
'• NEVER place bar stools on an edge where the countertop does not visibly overhang the cabinet face.',
'',
'Your job is to identify the find and stage only the Zones that are listed, if the zone is not listed the area is to be left vacant:',
'Find: {{room_assignment_variables}} go here',
'',
'"IF" Zone Anchors exist or do not exist you must follow these rules:',
'• "IF" Chandelier is found, this is the dining zone, place an area rug, table and chairs sized for the space centered directly below chandelier',
'• "If "no Chandelier is found, place an area rug, table and chairs sized for the dining zone sized appropriately for the open space',
'• "IF", Fireplace is found, place an area rug 18" from the front on the floor and centered on the fireplace with a coffee table',
'• "IF, Entry or Hallway is found, a 48" circular pathway must be maintained',
'• IF, Ceiling fan is found center furniture grouping around it.',
'',
'Identify the most logical furniture placement for each zone Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. circulation paths between zone boundaries.',
'',
'DESIGN STYLE & PALETTE',
'{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}',
'',
'OUTPUT REQUIREMENTS',
'Do not alter architecture.',
'',
'AB 723 COMPLIANCE',
'This analysis is for planning and visualization purposes only.',
'Do not alter, remove, relocate, resize, conceal, or modify any architectural element including walls, windows, doors, cabinetry, fireplaces, flooring, ceilings, lighting fixtures, appliances, or built-in features.',
'All architectural elements must remain exactly as photographed.'
].join('\n');

const OPEN_PLAN_ZONE_LABELS = { kitchen: 'Kitchen', dining: 'Dining', living: 'Living Room', family: 'Family Room', flex: 'Flex Room' };

// Style/palette key→display-label lookups, shared so both callers render the same labels
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
};

// Build the {{room_assignment_variables}} value: plain zone names, Flex Room inlined with its
// user-typed freetext (e.g. "Kitchen, Dining, Office (Flex Room)") — a name only, never a furniture script.
function buildRoomAssignmentVariable({ zoneList, flexNote, roomName, isOpenPlan }) {
  if (!isOpenPlan) return roomName || 'this room';
  if (!zoneList || !zoneList.length) return roomName || 'this room';
  const names = zoneList.map(z => {
    const zo = OPEN_PLAN_ZONE_LABELS[z] || z;
    return (z === 'flex' && flexNote) ? `${flexNote} (Flex Room)` : zo;
  });
  return names.join(', ');
}

// Build the Design DNA block: full Session DNA — Buyer Profile, Desired Feeling, Style, Staging Level, Palette —
// plus, when Design DNA has already been captured from a previously staged Open Plan room in this project,
// the captured furnishings DNA from extract-staging-dna.js (continuity only — no placement language).
function buildDesignDnaVariable({ style, palette, buyerProfile, desiredFeeling, stagingLevel, furnishingsDNA }) {
  const parts = [];
  if (style)          parts.push('Design Style: ' + style);
  if (palette)        parts.push('Color Palette: ' + palette);
  if (buyerProfile)   parts.push('Buyer Profile: ' + buyerProfile);
  if (desiredFeeling)  parts.push('Desired Feeling: ' + desiredFeeling);
  if (stagingLevel)    parts.push('Staging Level: ' + stagingLevel);
  let dnaText = parts.join('. ') + (parts.length ? '.' : '');
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

// assembleSpatialZonePrompt — pure template substitution, no Haiku, no scripted per-zone furniture.
// zones: { zoneList, flexNote, roomName, isOpenPlan } — the user's own Image Assignment selections.
// dna: { style, palette, buyerProfile, desiredFeeling, stagingLevel, furnishingsDNA } — Session DNA.
function assembleSpatialZonePrompt({ zones, dna }) {
  const roomAssignmentValue = buildRoomAssignmentVariable(zones || {});
  const designDnaValue = buildDesignDnaVariable(dna || {});
  return SPATIAL_ZONE_TEMPLATE
    .replace('{{room_assignment_variables}} go here', roomAssignmentValue)
    .replace('{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}', designDnaValue);
}

module.exports = {
  SPATIAL_ZONE_TEMPLATE,
  OPEN_PLAN_ZONE_LABELS,
  STYLE_LABELS,
  PALETTE_TONES,
  buildRoomAssignmentVariable,
  buildDesignDnaVariable,
  assembleSpatialZonePrompt,
};
