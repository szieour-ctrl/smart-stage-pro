// check-spatial-read.js — DIAGNOSTIC VERSION
// Logs exactly what Blobs returns so we can fix the extraction

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    console.log('🔍 check-spatial-read START');
    
    const jobId = event.queryStringParameters?.jobId;
    console.log('jobId=' + jobId);
    if (!jobId) {
      console.log('❌ Missing jobId');
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId" }) };
    }

    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;
    console.log('siteID=' + (siteID ? 'SET' : 'MISSING') + ', token=' + (token ? 'SET' : 'MISSING'));
    
    const store = getStore({ name: "spatial-jobs", siteID, token });
    console.log('✅ Store initialized');

    // Fetch from Blobs
    console.log('📥 Fetching from Blobs with jobId=' + jobId);
    const result = await store.get(jobId);
    
    console.log('📊 Blobs result type: ' + typeof result);
    console.log('📊 Blobs result keys: ' + (result ? Object.keys(result).join(', ') : 'null'));
    
    if (!result) {
      console.log('⏳ No result yet (status=pending)');
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    // Log what we got
    console.log('📋 Result structure:');
    console.log('  - result.key = ' + (result.key ? '"' + result.key + '"' : 'undefined'));
    console.log('  - result.value type = ' + typeof result.value);
    console.log('  - result.value length = ' + (result.value ? result.value.length : 'N/A'));
    if (result.value) {
      console.log('  - result.value (first 100 chars): ' + JSON.stringify(result.value).slice(0, 100));
    }
    console.log('  - result.shared = ' + result.shared);

    // Try to extract and parse the value
    let data;
    if (!result.value) {
      console.log('❌ result.value is missing!');
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Blobs returned empty value" }) };
    }

    // Handle different value types
    if (typeof result.value === 'string') {
      console.log('📄 Value is a STRING, parsing as JSON...');
      try {
        data = JSON.parse(result.value);
        console.log('✅ Parsed string as JSON');
      } catch (e) {
        console.log('❌ Failed to parse string: ' + e.message);
        console.log('String content (first 200 chars): ' + result.value.slice(0, 200));
        throw e;
      }
    } else if (typeof result.value === 'object') {
      console.log('📦 Value is already an OBJECT');
      data = result.value;
    } else {
      console.log('❌ Value is unexpected type: ' + typeof result.value);
      console.log('Value: ' + JSON.stringify(result.value));
      throw new Error('Unexpected value type from Blobs: ' + typeof result.value);
    }

    // Validate data structure
    console.log('🔍 Validating data structure...');
    console.log('  - data.status = ' + (data.status || 'undefined'));
    console.log('  - data.spatialData exists = ' + !!data.spatialData);
    if (data.spatialData) {
      console.log('  - data.spatialData.zones count = ' + (data.spatialData.zones ? data.spatialData.zones.length : 'undefined'));
    }

    console.log('✅ check-spatial-read returning data');
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error("❌ check-spatial-read error: " + err.message);
    console.error("Stack: " + err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
