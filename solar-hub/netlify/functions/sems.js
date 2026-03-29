// netlify/functions/sems.js
const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";
const LOGIN_URL = "https://au.semsportal.com/api/v2/common/crosslogin";
const DETAIL_URL = "https://au.semsportal.com/api/v2/PowerStation/GetMonitorDetailByPowerstationId";
const EMPTY_TOKEN = "eyJ1aWQiOiIiLCJ0aW1lc3RhbXAiOjAsInRva2VuIjoiIiwiY2xpZW50Ijoid2ViIiwidmVyc2lvbiI6IiIsImxhbmd1YWdlIjoiZW4ifQ==";

// Parse "1642(W)" → 1642
function parseW(str) {
  if (!str) return 0;
  const m = String(str).match(/([-\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

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
      uid: auth.uid, timestamp: auth.timestamp, token: auth.token,
      client: auth.client, version: auth.version, language: auth.language,
    });

    const res = await fetch(DETAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Token": tokenHeader },
      body: JSON.stringify({ powerStationId: STATION_ID }),
    });
    const text = await res.text();
    let resp;
    try { resp = JSON.parse(text); } catch(e) { throw new Error(`Detail parse error: ${text.slice(0,300)}`); }

    const detail  = resp.data || {};
    const kpi     = detail.kpi || {};
    const info    = detail.info || {};
    const pf      = detail.powerflow || {};
    const inv     = (detail.inverter || [])[0] || {};
    const full    = inv.invert_full || {};
    const stats   = detail.energeStatisticsCharts || {};

    // ── Power flows (W) ────────────────────────────────────────────────────
    // pmeter: negative = importing from grid, positive = exporting to grid
    const pmeter   = full.pmeter ?? 0;
    const pvPower  = full.pv_power ?? parseW(pf.pv) ?? 0;
    const homePower = parseW(pf.load) || Math.abs(pmeter) + pvPower;

    // Grid: pmeter negative means buying, positive means selling
    const gridPower   = pmeter;
    const importPower = Math.max(0, -pmeter);  // buying from grid
    const exportPower = Math.max(0,  pmeter);  // selling to grid

    // Battery
    const batterySoc   = full.soc ?? 0;
    const batteryPower = full.total_pbattery ?? 0;

    // ── Daily totals (kWh) ────────────────────────────────────────────────
    const dailyGeneration  = inv.eday   ?? kpi.power ?? 0;
    const dailyExport      = full.seller ?? stats.sell ?? 0;
    const dailyImport      = full.buy    ?? stats.buy  ?? 0;
    const dailyConsumption = stats.consumptionOfLoad
      ? parseFloat(String(stats.consumptionOfLoad)) / 1000  // convert Wh→kWh if needed
      : (dailyGeneration + dailyImport - dailyExport);

    const payload = {
      pvPower, gridPower, homePower, batteryPower, batterySoc,
      exportPower, importPower,
      dailyGeneration, dailyExport, dailyImport,
      dailyConsumption: parseFloat(dailyConsumption.toFixed(2)),
      stationName: info.stationname || "Home PV array",
      capacity: info.capacity || 13.2,
      timestamp: new Date().toISOString(),
    };

    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
