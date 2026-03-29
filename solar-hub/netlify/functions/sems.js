// netlify/functions/sems.js
// Proxies requests to the GoodWe SEMS Plus API

const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";

// SEMSplus uses a different base URL than old semsportal
const LOGIN_URL = "https://www.semsportal.com/api/v1/Common/CrossLogin";

async function getToken(email, password) {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Token": JSON.stringify({ version: "v2.1.0", client: "ios", language: "en" }),
    },
    body: JSON.stringify({ account: email, pwd: password }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error(`SEMS login parse error: ${text.slice(0,200)}`); }
  if (data.code !== 0) throw new Error(`SEMS login failed (code ${data.code}): ${data.msg}`);
  return data.data;
}

async function getStationDetail(auth) {
  const tokenHeader = JSON.stringify({
    version: "v2.1.0", client: "ios", language: "en",
    timestamp: auth.timestamp, uid: auth.uid, token: auth.token,
  });

  // ── Try both known API base URLs ──────────────────────────────────────────
  const apiBase = auth.api || "https://www.semsportal.com";
  const url = `${apiBase}/api/v1/PowerStation/GetMonitorDetailByPowerstationId`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Token": tokenHeader },
    body: JSON.stringify({ powerStationId: STATION_ID }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error(`SEMS detail parse error: ${text.slice(0,200)}`); }
  if (data.code !== 0) throw new Error(`SEMS detail failed (code ${data.code}): ${data.msg}`);
  return data.data;
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

    // DEBUG — return auth object so we can see what API url and fields come back
    if (event.queryStringParameters?.debug === '1') {
      return { statusCode: 200, headers, body: JSON.stringify({ debug_auth: auth }) };
    }

    const detail = await getStationDetail(auth);

    // ── Field mapping ──────────────────────────────────────────────────────
    // SEMSplus returns data in detail.kpi (station-level) and detail.inverter[]
    // We try multiple possible field names since firmware versions vary
    const kpi      = detail.kpi      || {};
    const info     = detail.info     || {};
    const inverter = (detail.inverter || [])[0] || {};
    const d        = detail.data     || {};

    // Grid power: positive = importing, negative = exporting
    // SEMSplus uses pgrid on kpi level, or on inverter level
    const rawGrid = kpi.pac_purchase  // some versions
      ?? kpi.pgrid
      ?? d.pgrid
      ?? inverter.pgrid
      ?? 0;

    const pvPower = kpi.pac
      ?? d.pac
      ?? inverter.pac
      ?? 0;

    const homePower = kpi.use_power
      ?? kpi.pload
      ?? d.pload
      ?? inverter.pload
      ?? 0;

    const batteryPower = kpi.pbat ?? d.pbat ?? inverter.pbat ?? 0;
    const batterySoc   = kpi.soc  ?? d.soc  ?? inverter.battery_charge ?? 0;

    // Daily kWh
    const dailyGeneration  = kpi.power      ?? info.eday_efficiency ?? d.eday ?? inverter.eday ?? 0;
    const dailyExport      = kpi.esell      ?? d.esell ?? 0;
    const dailyImport      = kpi.ebuy       ?? d.ebuy  ?? 0;
    const dailyConsumption = kpi.load_power ?? d.eload ?? 0;

    const exportPower = Math.max(0, -rawGrid);
    const importPower = Math.max(0,  rawGrid);

    const payload = {
      pvPower, gridPower: rawGrid, homePower, batteryPower, batterySoc,
      exportPower, importPower,
      dailyGeneration, dailyExport, dailyImport, dailyConsumption,
      stationName: info.stationname || "Home PV array",
      timestamp: new Date().toISOString(),
      // Full raw response for debugging — check browser console on first load
      _raw: { kpi, info, inverterKeys: Object.keys(inverter), dKeys: Object.keys(d) },
    };

    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
