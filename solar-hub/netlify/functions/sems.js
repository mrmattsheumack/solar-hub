// netlify/functions/sems.js
const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";
const LOGIN_URL = "https://au.semsportal.com/api/v2/common/crosslogin";
const DETAIL_URL = "https://au.semsportal.com/api/v2/PowerStation/GetMonitorDetailByPowerstationId";
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
  return parsed.data;
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

    const tokenHeader = JSON.stringify({
      uid: auth.uid,
      timestamp: auth.timestamp,
      token: auth.token,
      client: auth.client,
      version: auth.version,
      language: auth.language,
    });

    const res = await fetch(DETAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Token": tokenHeader },
      body: JSON.stringify({ powerStationId: STATION_ID }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { throw new Error(`Detail parse error: ${text.slice(0,300)}`); }

    if (event.queryStringParameters && event.queryStringParameters.debug === '2') {
      return { statusCode: 200, headers, body: JSON.stringify({ debug_detail: data }) };
    }

    // v2 response structure
    const detail = data.data || data;
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
        _raw: { kpi, info, inverterKeys: Object.keys(inverter), dKeys: Object.keys(d) },
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
