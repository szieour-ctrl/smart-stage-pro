// buildVacantPrompt__PHASE5A__.js
// Reads spatial read data from Haiku
// Applies Tier 1/2 anchor logic
// Generates furnishing instructions for GPT2

function applyTierLogic(zone) {
  /**
   * TIER 1: Zone has a visible ceiling-mounted fixture or fireplace
   * Examples: Chandelier, ceiling fan, island pendant, fireplace
   * 
   * TIER 2: Zone has no visible fixture - residual open space
   * Examples: Dining area with no chandelier, bedroom with no ceiling fixture
   */

  const zoneName = zone.zoneName || '';
  const anchorPoint = (zone.anchorPoint || '').trim();
  const fixtures = (zone.fixtures || '').toLowerCase();
  
  // Check if this is a circulation zone (should not be furnished)
  if (/hallway|circulation|entry|passage|corridor|foyer/i.test(zoneName)) {
    return {
      zoneName,
      tier: 'circulation',
      furnishing: 'LEAVE VACANT'
    };
  }

  // TIER 1: Visible fixture-based anchor
  const hasFireplace = /fireplace/.test(fixtures);
  const hasCeilingFan = /ceiling fan/.test(fixtures);
  const hasChandelierOrPendant = /chandelier|pendant/.test(fixtures);
  const hasIsland = /island/.test(fixtures);

  if (hasFireplace) {
    return {
      zoneName,
      tier: 1,
      anchorType: 'Fireplace',
      furnishing: 'Place an area rug proportional for the seating group 18" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug AND fireplace.'
    };
  }

  if (hasCeilingFan) {
    return {
      zoneName,
      tier: 1,
      anchorType: 'Ceiling Fan',
      furnishing: 'Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug AND ceiling fan.'
    };
  }

  if (hasChandelierOrPendant) {
    return {
      zoneName,
      tier: 1,
      anchorType: 'Chandelier/Pendant',
      furnishing: 'Place a round or rectangular dining table and seating not to exceed 6 chairs centered directly beneath the chandelier. Place an area rug proportional to seating group under the table.'
    };
  }

  if (hasIsland && /kitchen/.test(zoneName)) {
    return {
      zoneName,
      tier: 1,
      anchorType: 'Island',
      furnishing: 'Place counter seating at the island.'
    };
  }

  // TIER 2: No visible fixture - residual open space
  if (zoneName.toLowerCase().includes('dining') || zoneName.toLowerCase().includes('nook')) {
    return {
      zoneName,
      tier: 2,
      anchorType: 'Open space',
      furnishing: 'Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs in the open space.'
    };
  }

  if (zoneName.toLowerCase().includes('living') || zoneName.toLowerCase().includes('great room')) {
    return {
      zoneName,
      tier: 2,
      anchorType: 'Open space',
      furnishing: 'Place an area rug proportional for the seating group. Place a sofa facing the room center. Place accent chairs to complete the seating group.'
    };
  }

  if (zoneName.toLowerCase().includes('bedroom')) {
    return {
      zoneName,
      tier: 2,
      anchorType: 'Open space',
      furnishing: 'Place bed with headboard against the wall. Place matching nightstands flanking the bed.'
    };
  }

  // Default: Unknown zone
  return {
    zoneName,
    tier: 'unknown',
    furnishing: 'None'
  };
}

function buildVacantPrompt(spatialData, designStyle, colorPalette) {
  /**
   * INPUT: Spatial read data from Haiku (6-field zones)
   * OUTPUT: Zone descriptions with furnishing instructions for GPT2
   */

  if (!spatialData || !spatialData.zones || spatialData.zones.length === 0) {
    throw new Error('No spatial data provided to buildVacantPrompt');
  }

  // Apply tier logic to each zone
  const tieredZones = spatialData.zones.map(zone => applyTierLogic(zone));

  // Build zone descriptions for GPT2
  const zoneDescriptions = tieredZones.map(z => {
    const original = spatialData.zones.find(orig => orig.zoneName === z.zoneName);
    
    return {
      zoneName: z.zoneName,
      boundaries: original.boundaries,
      fixtures: original.fixtures,
      cabinetry: original.cabinetry,
      windowsDoors: original.windowsDoors,
      anchorPoint: z.anchorType || original.anchorPoint,
      focalPoint: original.focalPoint,
      furnishing: z.furnishing,
      tier: z.tier
    };
  });

  // Filter for logging
  const furnishedZones = zoneDescriptions.filter(z => z.furnishing !== 'LEAVE VACANT' && z.furnishing !== 'None');
  const vacantZones = zoneDescriptions.filter(z => z.furnishing === 'LEAVE VACANT');

  console.log('Tier logic applied:');
  console.log('  Furnished zones: ' + furnishedZones.map(z => z.zoneName).join(', '));
  console.log('  Vacant zones: ' + vacantZones.map(z => z.zoneName).join(', '));

  return {
    designStyle,
    colorPalette,
    zones: zoneDescriptions,
    furnishedZones: furnishedZones.length,
    vacantZones: vacantZones.length
  };
}

module.exports = { applyTierLogic, buildVacantPrompt };
