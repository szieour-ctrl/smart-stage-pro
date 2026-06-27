// check-spatial-read.js — DIAGNOSTIC VERSION
// Logs exactly what Blobs returns so we can confirm the extraction is correct

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

    const store = getStore({ name: "staging-jobs", siteID, token });
    console.log('✅ Store initialized');

    // Fetch from Blobs — { type: "json" } tells the SDK to parse the
    // stored JSON string and hand back the actual object directly.
    // (store.get() does NOT return a {key, value, shared} wrapper —
    // that shape belongs to a different storage API, not @netlify/blobs.
    // With type:'json', a missing key resolves to null; an existing key
    // resolves to the parsed object written by setJSON() in the worker.)
    console.log('📥 Fetching from Blobs with jobId=' + jobId);
    const data = await store.get(jobId, { type: "json" });

    console.log('📊 Blobs result type: ' + typeof data);
    console.log('📊 Blobs result keys: ' + (data ? Object.keys(data).join(', ') : 'null'));

    if (!data) {
      console.log('⏳ No result yet (status=pending)');
      return { statusCode: 200, headers, body: JSON.stringify({ status: "pending" }) };
    }

    // Validate data structure
    console.log('🔍 Validating data structure...');
    console.log('  - data.status = ' + (data.status || 'undefined'));
    console.log('  - data.spatialData exists = ' + !!data.spatialData);
    if (data.spatialData) {
      console.log('  - data.spatialData.perImageAssignments count = ' + (data.spatialData.perImageAssignments ? data.spatialData.perImageAssignments.length : 'undefined'));
    }
    if (data.status === 'error') {
      console.log('  - data.error = ' + data.error);
    }

    console.log('✅ check-spatial-read returning data, status=' + data.status);
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error("❌ check-spatial-read error: " + err.message);
    console.error("Stack: " + err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
