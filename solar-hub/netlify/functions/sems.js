// netlify/functions/sems.js
const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";
const LOGIN_URL = "https://au.semsportal.com/api/v2/common/crosslogin";
const EMPTY_TOKEN = "eyJ1aWQiOiIiLCJ0aW1lc3RhbXAiOjAsInRva2VuIjoiIiwiY2xpZW50Ijoid2ViIiwidmVyc2lvbiI6IiIsImxhbmd1YWdlIjoiZW4ifQ==";

async function getToken(email, password) {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Token": EMPTY_TOKEN },
    body: JSON.stringify({ account: email, pwd: password, agreement_agreement: 0, is_local: false }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch(e) { throw new Error(`Login parse error: ${text.slice(0,300)}`); }
  if (parsed.code !== 0) throw new Error(`Login failed (code ${parsed.code}): ${parsed.msg}`);
  const apiBase = parsed.api || "https://au.semsportal.com/api/";
  return { ...parsed.data, apiBase };
}

async function tryEndpoint(url, tokenHeader, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Token": tokenHeader },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const email = process.env.SEMS_EMAIL;
  const password = process.env.SEMS_PASSWORD;
  if (!email || !password) return {
    statusCode: 500, headers,
    body: JSON.stringify({ error: "SEMS_EMAIL or SEMS_PASSWORD env vars not set" }),
  };

  try {
    const auth = await getToken(email, password);

    if (event.queryStringParameters && event.queryStringParameters.debug === '1') {
      return { statusCode: 200, headers, body: JSON.stringify({ debug_auth: auth }) };
    }

    const tokenHeader = JSON.stringify({
      uid: auth.uid,
      timestamp: auth.timestamp,
      token: auth.token,
      client: auth.client,
      version: auth.version,
      language: auth.language,
    });

    const apiBase = auth.apiBase.replace(/\/$/, "");

    // Try multiple endpoint variations
    const endpoints = [
      `${apiBase}/v1/PowerStation/GetMonitorDetailByPowerstationId`,
      `${apiBase}/v2/PowerStation/GetMonitorDetailByPowerstationId`,
      `https://au.semsportal.com/api/v1/PowerStation/GetMonitorDetailByPowerstationId`,
      `https://www.semsportal.com/api/v1/PowerStation/GetMonitorDetailByPowerstationId`,
    ];

    if (event.queryStringParameters && event.queryStringParameters.debug === '2') {
      // Try all endpoints and report results
      const results = {};
      for (const url of endpoints) {
        const { status, text } = await tryEndpoint(url, tokenHeader, { powerStationId: STATION_ID });
        results[url] = { status, preview: text.slice(0, 200) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ results }) };
    }

    // Normal mode — try endpoints until one works
    let lastError = null;
    for (const url of endpoints) {
      const { status, text } = await tryEndpoint(url, tokenHeader, { powerStationId: STATION_ID });
      if (status === 200) {
        let data;
        try { data = JSON.parse(text); } catch(e) { continue; }
        if (data.code === 0) {
          const detail = data.data;
          const kpi      = detail.kpi      || {};
          const info     = detail.info     || {};
          const inverter = (detail.inverter || [])[0] || {};
          const d        = detail.data     || {};

          const rawGrid      = kpi.pac_purchase ?? kpi.pgrid ?? d.pgrid ?? inverter.pgrid ?? 0;
          const pvPower      = kpi.pac          ?? d.pac     ?? inverter.pac              ?? 0;
          const homePower    = kpi.use_power    ?? kpi.pload ?? d.pload ?? inverter.pload ?? 0;
          const batteryPower = kpi.pbat         ?? d.pbat    ?? inverter.pbat             ?? 0;
          const batterySoc   = kpi.soc          ?? d.soc     ?? inverter.battery_charge   ?? 0;
          const dailyGeneration  = kpi.power      ?? info.eday_efficiency ?? d.eday ?? inverter.eday ?? 0;
          const dailyExport      = kpi.esell      ?? d.esell ?? 0;
          const dailyImport      = kpi.ebuy       ?? d.ebuy  ?? 0;
          const dailyConsumption = kpi.load_power ?? d.eload ?? 0;
          const exportPower = Math.max(0, -rawGrid);
          const importPower = Math.max(0,  rawGrid);

          return {
            statusCode: 200, headers,
            body: JSON.stringify({
              pvPower, gridPower: rawGrid, homePower, batteryPower, batterySoc,
              exportPower, importPower,
              dailyGeneration, dailyExport, dailyImport, dailyConsumption,
              stationName: info.stationname || "Home PV array",
              timestamp: new Date().toISOString(),
              _usedUrl: url,
              _raw: { kpi, info, inverterKeys: Object.keys(inverter), dKeys: Object.keys(d) },
            }),
          };
        }
        lastError = `code ${data.code}: ${data.msg}`;
      } else {
        lastError = `HTTP ${status} from ${url}`;
      }
    }

    throw new Error(`All endpoints failed. Last error: ${lastError}`);
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
