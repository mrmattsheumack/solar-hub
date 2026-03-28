// netlify/functions/ecowitt.js
// Proxies requests to the Ecowitt cloud API v3

const ECOWITT_BASE = "https://api.ecowitt.net/api/v3";
const APPLICATION_KEY = "d4d54185-e9d9-4639-8fca-2c8593603558";
const MAC = "8C:4F:00:4F:FC:E2";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const apiKey = process.env.ECOWITT_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ECOWITT_API_KEY not set in environment variables" }),
    };
  }

  try {
    // Fetch real-time data
    const params = new URLSearchParams({
      application_key: APPLICATION_KEY,
      api_key: apiKey,
      mac: MAC,
      call_back: "all",
      temp_unitid: "1",      // Celsius
      pressure_unitid: "3",  // hPa
      wind_speed_unitid: "7",// km/h
      rainfall_unitid: "12", // mm
      solar_irradiance_unitid: "16", // W/m²
      capacity_unitid: "4",
    });

    const res = await fetch(`${ECOWITT_BASE}/device/real_time?${params}`);
    const data = await res.json();

    if (data.code !== 0) {
      throw new Error(`Ecowitt API error: ${data.msg}`);
    }

    const d = data.data || {};
    const outdoor = d.outdoor || {};
    const solar = d.solar_and_uvi || {};
    const wind = d.wind || {};
    const rainfall = d.rainfall || {};
    const pressure = d.pressure || {};
    const indoor = d.indoor || {};

    const payload = {
      temperature: parseFloat(outdoor.temperature?.value) || null,
      humidity: parseFloat(outdoor.humidity?.value) || null,
      solarIrradiance: parseFloat(solar.solar?.value) || null,  // W/m²
      uvi: parseFloat(solar.uvi?.value) || null,
      windSpeed: parseFloat(wind.wind_speed?.value) || null,
      windDirection: wind.wind_direction?.value || null,
      rainRate: parseFloat(rainfall.rain_rate?.value) || null,
      rainDaily: parseFloat(rainfall.daily?.value) || null,
      pressure: parseFloat(pressure.relative?.value) || null,
      indoorTemp: parseFloat(indoor.temperature?.value) || null,
      indoorHumidity: parseFloat(indoor.humidity?.value) || null,
      timestamp: new Date().toISOString(),
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
