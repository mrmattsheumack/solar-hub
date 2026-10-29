// netlify/functions/sems.js
const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";
const LOGIN_URL  = "https://au.semsportal.com/api/v2/common/crosslogin";
const DETAIL_URL = "https://au.semsportal.com/api/v2/PowerStation/GetMonitorDetailByPowerstationId";
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

    // ?probe=1 : one-off diagnostics. Tries alternative GoodWe endpoints and reports which return data.
    if ((event.queryStringParameters || {}).probe) {
      const base = auth._api || "https://au.semsportal.com/api/";
      const tries = [
        ["v2/PowerStation/GetMonitorDetailByPowerstationId", { powerStationId: STATION_ID }],
        ["v1/PowerStation/GetMonitorDetailByPowerstationId", { powerStationId: STATION_ID }],
        ["v2/PowerStation/GetPowerflow", { PowerStationId: STATION_ID }],
        ["v1/PowerStation/GetPowerflow", { PowerStationId: STATION_ID }],
        ["v3/PowerStation/GetPlantDetailByPowerstationId", { powerStationId: STATION_ID }],
        ["v2/PowerStation/GetInverterAllPoint", { powerStationId: STATION_ID }],
        ["v1/PowerStation/GetInverterAllPoint", { powerStationId: STATION_ID }],
        ["v2/PowerStationMonitor/QueryPowerStationMonitorForApp", { page_index: 1, page_size: 10, key: "", orderby: "", powerstation_id: "", powerstation_status: "", powerstation_type: "" }],
        ["v1/PowerStationMonitor/QueryPowerStationMonitor", { page_index: 1, page_size: 10, key: "", orderby: "", powerstation_id: "", powerstation_status: "", powerstation_type: "" }],
      ];
      const out = [];
      for (const [path, body] of tries) {
        try {
          const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "Token": tokenHeader }, body: JSON.stringify(body) });
          const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
          const d = j.data;
          const keys = d && typeof d === "object" ? Object.keys(Array.isArray(d) ? (d[0] || {}) : d).slice(0, 30) : [];
          const sample = {};
          if (d && typeof d === "object") {
            const src = Array.isArray(d) ? d[0] || {} : d;
            for (const k of ["powerflow", "pv", "load", "grid", "pac", "pmeter", "powerstation_id", "id", "stationname", "status"]) {
              if (src[k] !== undefined) sample[k] = typeof src[k] === "object" ? JSON.stringify(src[k]).slice(0, 300) : src[k];
            }
            if (src.list) sample.list = JSON.stringify(src.list).slice(0, 400);
          }
          out.push({ path, http: r.status, code: j.code, msg: j.msg, hasData: keys.length > 0, keys, sample });
        } catch (e) { out.push({ path, error: e.message }); }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ probe: out }, null, 1) };
    }

    // Fetch live detail + today's chart data in parallel
    const [detailRes, chartRes] = await Promise.all([
      fetch(DETAIL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Token": tokenHeader },
        body: JSON.stringify({ powerStationId: STATION_ID }),
      }),
      fetch(CHART_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Token": tokenHeader },
        body: JSON.stringify({
          powerStationId: STATION_ID,
          chartIndexId: "1",   // 1 = today power chart
          date: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        }),
      }),
    ]);

    const detailText = await detailRes.text();
    const chartText  = await chartRes.text();

    let resp, chartResp;
    try { resp      = JSON.parse(detailText); } catch(e) { throw new Error(`Detail parse error: ${detailText.slice(0,200)}`); }
    // Surface what GoodWe actually said (no credentials). Empty data used to become silent zeros.
    const semsStatus = {
      loginApi: auth._api,
      detailHttp: detailRes.status,
      detailCode: resp.code,
      detailMsg: resp.msg,
      detailHasData: !!(resp.data && Object.keys(resp.data).length),
      detailDataKeys: resp.data ? Object.keys(resp.data).slice(0, 25) : [],
      detailRaw: resp.data && Object.keys(resp.data).length ? undefined : detailText.slice(0, 300),
    };
    try { chartResp = JSON.parse(chartText);  } catch(e) { chartResp = {}; }

    const detail = resp.data || {};
    const kpi    = detail.kpi || {};
    const info   = detail.info || {};
    const pf     = detail.powerflow || {};
    const inv    = (detail.inverter || [])[0] || {};
    const full   = inv.invert_full || {};
    const stats  = detail.energeStatisticsCharts || {};

    // Live power flows
    // pmeter: negative = importing from grid, positive = exporting to grid
    const pmeter      = full.pmeter ?? 0;
    const gridPower   = pmeter;
    const importPower = Math.max(0, -pmeter);
    const exportPower = Math.max(0,  pmeter);

    // pvPower: try explicit fields first, then energy balance
    // Energy balance: pvPower = homePower + exportPower - importPower
    const pvRaw = full.pv_power || full.pac || parseW(pf.pv) || kpi.pac || 0;
    // homePower from powerflow load string e.g. "1642(W)"
    const homePower = parseW(pf.load) || 0;
    // Derive pvPower from energy balance if explicit field is 0
    // pvPower = load + export - import (conservation of energy)
    const pvBalanced = Math.max(0, homePower + exportPower - importPower);
    const pvPowerFinal = pvRaw > 0 ? pvRaw : pvBalanced;
    const batterySoc  = full.soc ?? 0;
    const batteryPower = full.total_pbattery ?? 0;

    // Daily totals
    const dailyGeneration  = inv.eday   ?? kpi.power ?? 0;
    const dailyExport      = full.seller ?? stats.sell ?? 0;
    const dailyImport      = full.buy    ?? stats.buy  ?? 0;
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
        _semsStatus: semsStatus,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
