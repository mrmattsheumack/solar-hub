// netlify/functions/ecowitt.js
// Proxies requests to the Ecowitt cloud API v3

const ECOWITT_BASE = "https://api.ecowitt.net/api/v3";
const APPLICATION_KEY = "7C78EE38078394C154BD80B2D874DBD3";
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
      capacity_unitid: "24",
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
    // The WS90 has a piezo (haptic) rain sensor, which the v3 API reports under
    // rainfall_piezo rather than rainfall. Prefer it, fall back to a tipping bucket.
    const hasRain = (o) => o && Object.keys(o).length > 0;
    const rainfall = hasRain(d.rainfall_piezo) ? d.rainfall_piezo : (d.rainfall || {});
    const rainSource = hasRain(d.rainfall_piezo) ? "piezo" : (hasRain(d.rainfall) ? "bucket" : null);
    const pressure = d.pressure || {};
    const indoor = d.indoor || {};

    // Zero is a real reading (0 mm rain, calm wind, 0 °C). Only a missing or
    // non-numeric value becomes null. The old `|| null` turned every 0 into null.
    const num = (v) => {
      const n = parseFloat(v?.value);
      return Number.isFinite(n) ? n : null;
    };

    const payload = {
      temperature: num(outdoor.temperature),
      humidity: num(outdoor.humidity),
      feelsLike: num(outdoor.feels_like),
      dewPoint: num(outdoor.dew_point),
      solarIrradiance: num(solar.solar),  // W/m²
      uvi: num(solar.uvi),
      windSpeed: num(wind.wind_speed),
      windGust: num(wind.wind_gust),
      windDirection: num(wind.wind_direction),
      rainRate: num(rainfall.rain_rate),
      rainDaily: num(rainfall.daily),
      rainEvent: num(rainfall.event),
      rainHourly: num(rainfall.hourly) ?? num(rainfall["1_hour"]),
      rainWeekly: num(rainfall.weekly),
      rainMonthly: num(rainfall.monthly),
      rainYearly: num(rainfall.yearly),
      rainSource,
      pressure: num(pressure.relative),
      indoorTemp: num(indoor.temperature),
      indoorHumidity: num(indoor.humidity),
      stationTime: d.outdoor?.temperature?.time ? new Date(Number(d.outdoor.temperature.time) * 1000).toISOString() : null,
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
