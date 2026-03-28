// netlify/functions/sems.js
// Proxies requests to the GoodWe SEMS Plus API

const SEMS_BASE = "https://semsplus.goodwe.com";
const STATION_ID = "f04ed04f-8f02-4eda-9fc9-03c68fab7ad2";

async function getToken(email, password) {
  const res = await fetch(`${SEMS_BASE}/api/v1/Common/CrossLogin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: JSON.stringify({ version: "v2.1.0", client: "ios", language: "en" }),
    },
    body: JSON.stringify({ account: email, pwd: password }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`SEMS login failed: ${data.msg}`);
  return data.data;
}

async function getStationDetail(auth) {
  const tokenHeader = JSON.stringify({
    version: "v2.1.0",
    client: "ios",
    language: "en",
    timestamp: auth.timestamp,
    uid: auth.uid,
    token: auth.token,
  });

  const res = await fetch(
    `${auth.api}/v1/PowerStation/GetMonitorDetailByPowerstationId`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: tokenHeader,
      },
      body: JSON.stringify({ powerStationId: STATION_ID }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`SEMS data fetch failed: ${data.msg}`);
  return data.data;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const email = process.env.SEMS_EMAIL;
  const password = process.env.SEMS_PASSWORD;

  if (!email || !password) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "SEMS credentials not configured in environment variables" }),
    };
  }

  try {
    const auth = await getToken(email, password);
    const detail = await getStationDetail(auth);

    // Normalise the key fields we care about
    const inverter = detail.inverter?.[0] || {};
    const d = detail.data || {};

    const payload = {
      // Power flows (watts)
      pvPower: d.pac || inverter.pac || 0,           // Solar generation
      gridPower: d.pgrid || 0,                        // + = importing, - = exporting
      homePower: d.pload || 0,                        // Home consumption
      batteryPower: d.pbat || 0,                      // + = charging, - = discharging
      batterySoc: d.soc || inverter.battery_charge || 0,

      // Derived
      exportPower: Math.max(0, -(d.pgrid || 0)),      // watts being sent to grid
      importPower: Math.max(0, d.pgrid || 0),         // watts being pulled from grid

      // Daily totals (kWh)
      dailyGeneration: d.eday || inverter.eday || 0,
      dailyExport: d.esell || 0,
      dailyImport: d.ebuy || 0,
      dailyConsumption: d.eload || 0,

      // Status
      status: inverter.status || d.status || 0,
      stationName: detail.info?.stationname || "Home PV array",
      timestamp: new Date().toISOString(),
      raw: detail, // include raw for debugging
    };

    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
