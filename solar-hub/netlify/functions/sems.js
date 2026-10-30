// netlify/functions/sems.js
const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";
const LOGIN_URL  = "https://au.semsportal.com/api/v2/common/crosslogin";
// GetMonitorDetailByPowerstationId stopped returning data (Oct 2026, after the SEMS+ migration):
// code 0, "success", but data {}. Live flows now come from GetPowerflow, totals from v3 plant detail.
const POWERFLOW_URL = "https://au.semsportal.com/api/v2/PowerStation/GetPowerflow";
const PLANT_URL     = "https://au.semsportal.com/api/v3/PowerStation/GetPlantDetailByPowerstationId";
const CHART_URL  = "https://au.semsportal.com/api/v2/Charts/GetChartByPlant";
const EMPTY_TOKEN = "eyJ1aWQiOiIiLCJ0aW1lc3RhbXAiOjAsInRva2VuIjoiIiwiY2xpZW50Ijoid2ViIiwidmVyc2lvbiI6IiIsImxhbmd1YWdlIjoiZW4ifQ==";

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
  try { parsed = JSON.parse(text); } catch(e) { throw new Error(`Login parse error: ${text.slice(0,200)}`); }
  if (parsed.code !== 0) throw new Error(`Login failed (${parsed.code}): ${parsed.msg}`);
  // GoodWe returns the API base for this account's region; older code ignored it
  return { ...parsed.data, _api: parsed.api || (parsed.components && parsed.components.api) || null };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const email    = process.env.SEMS_EMAIL;
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

    const post = (url, body) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Token": tokenHeader },
      body: JSON.stringify(body),
    });
    const [pfRes, plantRes, chartRes] = await Promise.all([
      post(POWERFLOW_URL, { PowerStationId: STATION_ID }),
      post(PLANT_URL, { powerStationId: STATION_ID }),
      post(CHART_URL, {
        powerStationId: STATION_ID,
        chartIndexId: "1",   // 1 = today power chart
        date: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
      }),
    ]);
    const parse = async (r, label) => {
      const t = await r.text();
      try { return JSON.parse(t); } catch (e) { throw new Error(`${label} parse error: ${t.slice(0, 200)}`); }
    };
    const pfResp    = await parse(pfRes, "Powerflow");
    const plantResp = await parse(plantRes, "Plant detail").catch(() => ({}));
    let chartResp; try { chartResp = await chartRes.json(); } catch (e) { chartResp = {}; }

    const pf    = (pfResp.data || {}).powerflow || {};
    if (!pf.pv && !pf.load) {
      // Never hand back silent zeros again: make the failure visible to callers
      return { statusCode: 502, headers, body: JSON.stringify({
        error: "SEMS powerflow returned no data", code: pfResp.code, msg: pfResp.msg,
      }) };
    }
    const plant = plantResp.data || {};
    const kpi   = plant.kpi || {};
    const info  = plant.info || {};
    const stats = {};

    // Live power flows (W). pf.grid is unsigned and pf.gridStatus is not a reliable
    // direction flag (seen -1 while exporting). No battery here, so the direction
    // follows from the balance: pv > load means exporting, pv < load means importing.
    const pvW   = parseW(pf.pv);
    const homeW = parseW(pf.load);
    const gridW = parseW(pf.grid);
    const exporting = pvW > homeW;
    const importPower = exporting ? 0 : gridW;
    const exportPower = exporting ? gridW : 0;
    const gridPower   = exportPower - importPower;   // + export, - import (same sign as old pmeter)
    const homePower   = homeW;
    const pvPowerFinal = pvW > 0 ? pvW : Math.max(0, homeW + exportPower - importPower);
    const batterySoc   = pf.soc ?? 0;
    const batteryPower = parseW(pf.bettery);

    // Daily totals
    const dailyGeneration  = kpi.power ?? 0;
    const dailyExport      = 0;   // not in the new endpoints; chart below carries the shape
    const dailyImport      = 0;
    const dailyConsumption = stats.consumptionOfLoad ?? (dailyGeneration + dailyImport - dailyExport);

    // Parse hourly chart data
    // chartResp.data may contain arrays like lines[0].xy = [{x: "06:00", y: 1234}, ...]
    let hourlyChart = [];
    try {
      const chartData = chartResp.data || chartResp;
      const lines = chartData.lines || chartData.datas || [];
      // lines[0] = PV power, lines[1] = grid power (negative=import, positive=export), lines[2] = load
      if (lines.length >= 1) {
        const pvLine   = lines[0]?.xy || lines[0]?.data || [];
        const gridLine = lines[1]?.xy || lines[1]?.data || [];
        const loadLine = lines[2]?.xy || lines[2]?.data || [];
        const times = pvLine.map(p => p.x || p[0]);
        hourlyChart = times.map((t, i) => {
          const pv   = parseFloat(pvLine[i]?.y   ?? pvLine[i]?.[1]   ?? 0) * 1000; // kW→W
          const grid = parseFloat(gridLine[i]?.y  ?? gridLine[i]?.[1]  ?? 0) * 1000;
          const load = parseFloat(loadLine[i]?.y  ?? loadLine[i]?.[1]  ?? 0) * 1000;
          return {
            time: t,
            pvPower:    Math.round(Math.max(0, pv)),
            gridImport: Math.round(Math.max(0, -grid)),
            gridExport: Math.round(Math.max(0,  grid)),
            homePower:  Math.round(Math.max(0, load || Math.abs(grid) + pv)),
          };
        });
      }
    } catch(e) {
      hourlyChart = [];
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        pvPower: Math.round(pvPowerFinal), gridPower, homePower: Math.round(homePower), batteryPower, batterySoc,
        exportPower, importPower,
        dailyGeneration, dailyExport, dailyImport,
        dailyConsumption: parseFloat(Number(dailyConsumption).toFixed(2)),
        stationName: info.stationname || "Home PV array",
        capacity: info.capacity || 13.2,
        timestamp: new Date().toISOString(),
        hourlyChart,
        // debug chart shape if empty
        _chartDebug: hourlyChart.length === 0 ? { code: chartResp.code, keys: Object.keys(chartResp.data || {}) } : null,
        _source: "powerflow",
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
