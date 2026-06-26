// group-spatial-read-background.js — DIAGNOSTIC VERSION
// Logs EVERY step to identify where the pipeline breaks

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { 
          resolve({ status: res.statusCode, body: JSON.parse(raw) }); 
        } catch (e) { 
          resolve({ status: res.statusCode, body: { raw } }); 
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function prepareImage(imageBase64, mimeType) {
  console.log('🖼️  prepareImage: input size=' + Math.round(imageBase64.length / 1024) + 'KB');
  const buffer = Buffer.from(imageBase64, 'base64');
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  console.log('📐 Image: width=' + meta.width + ' height=' + meta.height + ' sizeKB=' + sizeKB);
  
  if (maxDim <= 768 && sizeKB <= 80) {
    console.log('✅ Image already small, no compress needed');
    return { base64: imageBase64, mimeType };
  }
  
  console.log('🗜️  Compressing image...');
  const compressed = await sharp(buffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  console.log('✅ Compressed: ' + Math.round(compressed.length / 1024) + 'KB');
  return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
}

function buildHaikuSpatialReadPrompt() {
  return `YOU ARE A PROFESSIONAL SPATIAL ARCHITECT ANALYZING REAL ESTATE PHOTOGRAPHS.

YOUR TASK: Read the uploaded room photo and identify FURNISHING ZONES based ONLY on visible architecture, fixtures, and boundaries present in each zone.

CRITICAL RULE: List ONLY what is physically present in or attached to each zone. NO relationships to other zones. NO directional language.

═════════════════════════════════════════════════════════════════════════════════

ZONE IDENTIFICATION
Analyze the photograph and identify distinct furnishing zones using architectural boundaries:
- Walls, partial walls, pass-throughs
- Windows, glass doors, French doors
- Fireplaces, ceiling fans, chandeliers
- Kitchen islands, counters, cabinets
- Ceiling changes, recessed lighting clusters
- Hallways and circulation paths

For EACH zone, output a JSON block:
{
  "name": "Zone Name (Kitchen, Dining, Living, Hallway, Bedroom, etc.)",
  "boundaries": "Description of zone boundaries",
  "fixtures": "List fixtures visible IN this zone",
  "cabinetry": "Cabinetry IN this zone (or None)",
  "windows_doors": "Windows/doors IN this zone",
  "anchor_point": {
    "location": "Chandelier | Fireplace | Ceiling Fan | Pendant | None",
    "confidence": "HIGH | MEDIUM | LOW"
  },
  "focal_point": "Visual anchor within zone"
}

OUTPUT FORMAT
Return ONLY a valid JSON array of zone objects. No preamble, no Markdown backticks.

[
  { "name": "...", "boundaries": "...", "fixtures": "...", "cabinetry": "...", "windows_doors": "...", "anchor_point": {...}, "focal_point": "..." },
  ...
]`;
}

function applyTierLogic(zones) {
  console.log('📊 applyTierLogic: processing ' + zones.length + ' zones');
  
  if (!Array.isArray(zones)) zones = [zones];
  
  return zones.map((zone, idx) => {
    const zoneName = (zone.name || zone.zoneName || '').toLowerCase();
    const anchorPoint = (zone.anchor_point?.location || zone.anchorPoint || '').toLowerCase();
    const hasAnchor = anchorPoint && anchorPoint !== 'none' && anchorPoint.length > 0;
    
    console.log(`  Zone ${idx}: name="${zone.name}" anchor="${anchorPoint}" → applying tier logic`);
    
    let furnishing = '';

    // HALLWAY / CIRCULATION
    if (zoneName.includes('hallway') || zoneName.includes('circulation') || zoneName.includes('entry') || zoneName.includes('foyer')) {
      furnishing = 'LEAVE VACANT';
      console.log(`    ✅ Hallway → LEAVE VACANT`);
    }
    // KITCHEN
    else if (zoneName.includes('kitchen')) {
      furnishing = 'Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
      console.log(`    ✅ Kitchen → Tier logic applied`);
    }
    // DINING + CHANDELIER (Tier 1)
    else if (zoneName.includes('dining') && anchorPoint.includes('chandelier')) {
      furnishing = 'Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
      console.log(`    ✅ Dining + Chandelier → Tier 1 (rug placement instruction)`);
    }
    // DINING + NO ANCHOR (Tier 2)
    else if (zoneName.includes('dining') && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
      console.log(`    ✅ Dining + No Anchor → Tier 2 (generic)`);
    }
    // LIVING + FIREPLACE (Tier 1)
    else if ((zoneName.includes('living') || zoneName.includes('great room') || zoneName.includes('family room')) && anchorPoint.includes('fireplace')) {
      furnishing = 'Place an area rug proportional for the seating group 18" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
      console.log(`    ✅ Living + Fireplace → Tier 1 (18" rug rule)`);
    }
    // LIVING + NO FIREPLACE (Tier 2)
    else if ((zoneName.includes('living') || zoneName.includes('great room') || zoneName.includes('family room')) && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
      console.log(`    ✅ Living + No Anchor → Tier 2 (generic)`);
    }
    // BEDROOM
    else if (zoneName.includes('bedroom')) {
      furnishing = 'Style & Main Pieces: Bed (1), nightstands (2), accent seating (optional). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
      console.log(`    ✅ Bedroom → Tier logic applied`);
    }
    else {
      console.log(`    ⚠️  Zone type not recognized: "${zone.name}"`);
    }

    return { ...zone, furnishing };
  });
}

exports.handler = async (event) => {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🚀 HANDLER START');
  console.log('📥 event.body length:', event.body?.length || 0);
  
  try {
    // Parse body
    console.log('🔍 Step 1: Parse request body');
    let body = {};
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
      console.log('✅ Body parsed');
      console.log('📋 Body keys:', Object.keys(body));
    } catch (e) {
      console.error('❌ Body parse error:', e.message);
      body = {};
    }

    const { images, groupType, jobId: incomingJobId } = body;
    const jobId = incomingJobId || `gsr-${Date.now()}`;

    console.log(`\n🔍 Step 2: Validate inputs`);
    console.log(`  jobId=${jobId}`);
    console.log(`  images count=${images?.length || 0}`);
    console.log(`  groupType=${groupType}`);

    if (!images || images.length === 0) {
      throw new Error('No images in request body. Received: ' + JSON.stringify(Object.keys(body)));
    }

    // Get Blobs store
    console.log(`\n🔍 Step 3: Initialize Blobs store`);
    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;
    console.log(`  siteID=${siteID ? 'SET' : 'MISSING'}`);
    console.log(`  token=${token ? 'SET' : 'MISSING'}`);
    
    if (!siteID || !token) {
      throw new Error('Netlify env vars missing: siteID=' + !!siteID + ', token=' + !!token);
    }
    
    const store = getStore({ name: 'spatial-jobs', siteID, token });
    console.log('✅ Blobs store initialized');

    // Prepare images
    console.log(`\n🔍 Step 4: Prepare ${images.length} images`);
    const preparedImages = await Promise.all(
      images.map(img => prepareImage(img.base64, img.mimeType))
    );
    console.log(`✅ ${preparedImages.length} images prepared`);

    // Call Haiku
    console.log(`\n🔍 Step 5: Call Haiku API`);
    const prompt = buildHaikuSpatialReadPrompt();
    const imageContent = preparedImages.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
    }));
    imageContent.push({ type: 'text', text: prompt });

    const payload = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      messages: [{ role: 'user', content: imageContent }]
    });

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) throw new Error('ANTHROPIC_API_KEY missing');

    console.log('📤 Sending to Haiku: ' + Math.round(payload.length / 1024) + 'KB payload');
    const haikuResponse = await httpsRequest({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    console.log(`✅ Haiku response: status=${haikuResponse.status}`);
    if (haikuResponse.status !== 200) {
      throw new Error(`Haiku error ${haikuResponse.status}: ` + JSON.stringify(haikuResponse.body).slice(0, 200));
    }

    // Parse Haiku response
    console.log(`\n🔍 Step 6: Parse Haiku zones`);
    const textContent = haikuResponse.body.content?.find(c => c.type === 'text');
    if (!textContent) throw new Error('No text in Haiku response');

    console.log('📄 Haiku text length:', textContent.text.length);
    let zones = [];
    try {
      zones = JSON.parse(textContent.text);
      console.log(`✅ Parsed ${zones.length} zones`);
    } catch (e) {
      console.error('❌ Zone parse error:', e.message);
      throw new Error(`Failed to parse zones: ${e.message}. Text: ` + textContent.text.slice(0, 200));
    }

    if (!Array.isArray(zones)) zones = [zones];
    if (zones.length === 0) throw new Error('No zones parsed from Haiku');

    // Apply tier logic
    console.log(`\n🔍 Step 7: Apply tier logic`);
    const tieredZones = applyTierLogic(zones);
    console.log(`✅ Tier logic applied to ${tieredZones.length} zones`);

    // Build result
    console.log(`\n🔍 Step 8: Build result object`);
    const resultObject = {
      status: 'done',
      spatialData: {
        zones: tieredZones,
        confidence: 'HIGH'
      },
      timestamp: new Date().toISOString()
    };

    // Validate JSON
    console.log('✅ Validating result JSON...');
    const jsonString = JSON.stringify(resultObject);
    console.log('  JSON size: ' + Math.round(jsonString.length / 1024) + 'KB');
    JSON.parse(jsonString); // Test parse
    console.log('✅ JSON valid');

    // Store in Blobs
    console.log(`\n🔍 Step 9: Store result in Blobs with jobId="${jobId}"`);
    console.log('💾 Calling store.set()...');
    await store.set(jobId, resultObject, { type: 'json' });
    console.log('✅ Successfully stored in Blobs');

    console.log(`\n🎉 HANDLER SUCCESS - jobId=${jobId}`);
    console.log('════════════════════════════════════════════════════════════════\n');
    return { statusCode: 200, body: JSON.stringify({ success: true, jobId }) };

  } catch (err) {
    console.error(`\n❌ HANDLER ERROR: ${err.message}`);
    console.error('Stack:', err.stack);
    
    // Try to store error in Blobs
    try {
      const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
      const token = process.env.NETLIFY_ACCESS_TOKEN;
      const store = getStore({ name: 'spatial-jobs', siteID, token });
      
      const errorResult = {
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString()
      };
      
      const errorJobId = `gsr-error-${Date.now()}`;
      await store.set(errorJobId, errorResult, { type: 'json' });
      console.log('💾 Error stored in Blobs with jobId=' + errorJobId);
    } catch (storageErr) {
      console.error('⚠️  Failed to store error in Blobs:', storageErr.message);
    }

    console.log('════════════════════════════════════════════════════════════════\n');
    return { statusCode: 500, body: JSON.stringify({ error: err.message, jobId: 'error-' + Date.now() }) };
  }
};
