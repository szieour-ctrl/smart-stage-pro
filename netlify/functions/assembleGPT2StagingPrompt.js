// assembleGPT2StagingPrompt__PHASE5A__.js
// Receives zone descriptions from buildVacantPrompt
// Assembles into boilerplate + zones for GPT2

function assembleGPT2StagingPrompt(tieredZoneData, imageCount) {
  /**
   * INPUT: Zone descriptions with furnishing instructions from buildVacantPrompt()
   * OUTPUT: Complete prompt for GPT2 staging
   */

  const { designStyle, colorPalette, zones } = tieredZoneData;

  // ── BOILERPLATE SECTION (ONE TIME) ─────────────────────────────────────────
  const boilerplate = `PRIMARY ROLE: You are a professional luxury real estate interior designer, home stager, and architectural photographer.

AB 723 COMPLIANCE REQUIREMENTS (HIGHEST PRIORITY)

TASK: Analyze the uploaded room photograph and identify all functional furnishing zones based solely on the visible architecture, fixtures, openings, windows, cabinetry, fireplaces, built-ins, ceiling features, and circulation paths.

Determine a visual spatial map that clearly illustrates where furniture should be placed within the room or zone.

ZONE IDENTIFICATION RULES

Determine zone boundaries using architectural cues including:
• Walls
• Partial walls
• Openings
• Doorways
• Windows
• Sliding glass doors
• Fireplaces
• Kitchen islands
• Cabinetry
• Ceiling changes
• Chandeliers
• Pendant lighting
• Ceiling fans
• Built-ins
• Hallways (stay unobstructed)
• Circulation paths

Preserve exactly all architectural elements, room dimensions, ceiling heights, wall locations, window locations, door locations, fireplaces, cabinetry, countertops, appliances, flooring, lighting fixtures, HVAC vents, trim, skylights, built-ins, and all permanent fixtures.

Do not add, remove, relocate, resize, conceal, replace, or alter any permanent architectural feature.

Do not modify room dimensions, ceiling heights, window sizes, window locations, door locations, cabinetry, fireplaces, flooring, or structural openings.

Virtual staging may add furniture, rugs, artwork, plants, electronics, lighting accessories, and decorative objects only.

Any alteration to permanent architecture violates California AB 723 compliance standards.

SPATIAL PRESERVATION

Respect the exact camera position, focal length, perspective, room proportions, and spatial geometry shown in the original photograph.

Maintain all architectural sightlines, circulation paths, and relationships between walls, openings, windows, cabinetry, and fixtures.

Treat each furnishing zone as an independent furnishing area bounded by permanent architectural elements.

Furniture must remain entirely within its assigned zone and may not extend into adjacent zones, hallways, kitchen work areas, doorways, fireplaces, windows, or architectural openings.

PHOTOGRAPHIC DEPTH & COMPOSITION

Create strong foreground, midground, and background visual layers to increase depth perception.

Arrange furnishings to create a natural visual progression through the room rather than placing all furniture against walls.

Use furniture groupings, rugs, tables, plants, artwork, and accessories to establish realistic spatial hierarchy.

Maintain proper furniture scale and realistic spacing throughout the room.

Anchor all furniture naturally to the floor with realistic contact shadows.

LIGHTING & REALISM

Preserve all existing natural and artificial light sources exactly as photographed.

Maintain realistic daylight behavior from windows, skylights, and glass doors.

Create natural shadow falloff, reflected light, and subtle contrast variations.

Avoid flat lighting, excessive brightness, blown highlights, or artificial HDR appearance.

Use realistic material behavior for wood, fabric, stone, metal, glass, and upholstery.

DESIGN EXECUTION

Stage in the selected design style and color palette.

Create a professionally designed, market-ready interior suitable for luxury real estate marketing.

Add carefully curated furniture, artwork, accessories, greenery, and styling details that support the selected buyer profile.

Avoid clutter, overcrowding, exaggerated furniture sizes, or unrealistic luxury elements.

FINAL IMAGE REQUIREMENTS

The finished image must appear indistinguishable from a professionally photographed and professionally staged real property.

The result should feel spatially accurate, naturally furnished, architecturally preserved, and fully compliant with California AB 723 virtual staging requirements.

The final image must look like a real photograph, not a rendering, illustration, CGI image, or AI-generated composition.

═════════════════════════════════════════════════════════════════════════════════

DESIGN SPECIFICATION

There are ${zones.length} zones in this image.

Stage all zones in ${designStyle} design style using ${colorPalette} palette with ${colorPalette} tones throughout.

═════════════════════════════════════════════════════════════════════════════════

ZONE DESCRIPTIONS AND FURNISHING INSTRUCTIONS

`;

  // ── ZONE DESCRIPTIONS SECTION ──────────────────────────────────────────────
  const zoneDescriptions = zones.map(zone => {
    return `Zone: ${zone.zoneName}
• Boundaries: ${zone.boundaries}
• Fixtures: ${zone.fixtures}
• Cabinetry: ${zone.cabinetry}
• Windows/Doors: ${zone.windowsDoors}
• Anchor Point: ${zone.anchorPoint}
• Focal Point: ${zone.focalPoint}
• Furnishing: ${zone.furnishing}
`;
  }).join('\n');

  // ── FINAL ASSEMBLY ─────────────────────────────────────────────────────────
  const fullPrompt = boilerplate + zoneDescriptions;

  return fullPrompt.trim();
}

module.exports = { assembleGPT2StagingPrompt };
