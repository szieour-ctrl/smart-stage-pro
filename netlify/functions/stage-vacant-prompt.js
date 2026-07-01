// stage-vacant-prompt.js — Single Room Vacant Staging + Clean+Stage Step 2
//
// Phase 6.2: no Haiku zone-read here anymore. Builds the staging prompt by calling
// assembleSpatialZonePrompt() directly from the shared spatial-zone-template module —
// the exact same template used everywhere else staging prompts are built.
// Haiku's only remaining jobs in this app are: (1) the Declutter/Clean spatial read
// (declutter-prompt.js — a genuinely different task: identifying furniture to REMOVE,
// not zones to stage), and (2) furnishings DNA extraction from an already-staged Open
// Plan room (extract-staging-dna.js), captured once per project and reused for every
// other room. Neither of those happens in this file.
//
// Used by:
//   - stageRoom() in index.html — plain "Stage This Room" on a vacant/original photo
//   - runCleanAndStage() in index.html — step 2, staging the decluttered image
//
// v1 addition: projectId is now passed through to assembleSpatialZonePrompt so the
// shared module can deterministically pick a per-project Furniture Profile from
// STYLE_FURNITURE_VOCABULARY — same project always gets the same furniture across
// rooms, different projects of the same style get different furniture. See
// spatial-zone-template.js for the full mechanism.

const { assembleSpatialZonePrompt, STYLE_LABELS, PALETTE_TONES } = require('./spatial-zone-template');

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const {
      roomType, designStyle, colorPalette,
      isOpenPlan, zoneList, flexNote,
      buyerProfile, desiredFeeling, stagingLevel,
      furnishingsDNA, projectId,
    } = JSON.parse(event.body);

    if (!roomType) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing roomType" }) };

    const stagingPrompt = assembleSpatialZonePrompt({
      zones: {
        zoneList: zoneList || [],
        flexNote: flexNote || '',
        roomName: roomType,
        isOpenPlan: !!isOpenPlan,
      },
      dna: {
        style: STYLE_LABELS[(designStyle || '').toLowerCase().replace(/[^a-z]/g, '')] || designStyle || 'Transitional',
        palette: PALETTE_TONES[colorPalette] ? colorPalette : (colorPalette || 'Warm Neutrals'),
        buyerProfile: buyerProfile || '',
        desiredFeeling: desiredFeeling || '',
        stagingLevel: stagingLevel || '',
        furnishingsDNA: furnishingsDNA || null,
        projectId: projectId || null,
      }
    });

    console.log('stage-vacant-prompt: assembled ' + stagingPrompt.length + ' chars for "' + roomType + '"' + (isOpenPlan ? ' (open plan: ' + (zoneList || []).join(',') + ')' : '') + (furnishingsDNA ? ' [with furnishings DNA]' : '') + (projectId ? ' [projectId: ' + projectId + ']' : ' [no projectId — furniture profile will not be deterministic across rooms]'));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        stagingPrompt,
        message: "Prompt ready for editing. Review and modify if needed, then click STAGE to send to GPT Image 2."
      })
    };

  } catch (err) {
    console.error("stage-vacant-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, details: err.stack }) };
  }
};
