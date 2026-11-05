// netlify/functions/ecowitt.js
// Proxies requests to the Ecowitt cloud API v3

const ECOWITT_BASE = "https://api.ecowitt.net/api/v3";
const APPLICATION_KEY = "7C78EE38078394C154BD80B2D874DBD3";
const MAC = "8C:4F:00:4F:FC:E2";
// WN31 room sensor channel -> Climate Control room id. Channel = iZone zone number.
const CHANNEL_ROOMS = { 1: "lounge", 2: "master", 3: "charlie", 4: "mila", 5: "office", 6: "bath" };
// Channels with a WN31 actually installed. Only these become room readings. The gateway keeps
// repeating the last value it heard on any channel (e.g. one a sensor passed through while its
// switches were being changed), and the cloud stamps those with the current time, so a ghost
// channel looks live. Add a channel here when a sensor is installed on it.
const INSTALLED_CHANNELS = [4];   // 5 Nov 2026: pilot sensor in Mila's room

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

  // ?history=today -> today's readings from midnight (Melbourne time), 5-minute steps, for the Weather page.
  // &hours=N (1-23) also reaches back at least N hours, so just after midnight there is still a recent
  // stretch to show (the range never exceeds 24 hours). Callers filter to midnight for "today" figures.
  const q = event.queryStringParameters || {};
  // ?devices=1 -> the Ecowitt devices on the account (name, model, MAC) and which one this site reads.
  // Read-only; used to check which unit the "indoor" reading comes from.
  if (q.devices) {
    try {
      const lp = new URLSearchParams({ application_key: APPLICATION_KEY, api_key: apiKey, page: "1", limit: "20" });
      const r = await fetch(`${ECOWITT_BASE}/device/list?${lp}`);
      const j = await r.json();
      if (j.code !== 0) throw new Error(`Ecowitt device list error: ${j.msg}`);
      const list = (j.data && (j.data.list || j.data)) || [];
      const devices = (Array.isArray(list) ? list : []).map(d => ({
        name: d.name, mac: d.mac, model: d.stationtype || d.type, type: d.type, createdAt: d.createtime || d.date_zone_id || null,
        readBySite: String(d.mac || "").toUpperCase() === MAC,
      }));
      return { statusCode: 200, headers: { ...headers, "Cache-Control": "no-store" }, body: JSON.stringify({ siteMac: MAC, devices }) };
    } catch (err) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
    }
  }
  if (q.history === "today") {
    try {
      const melFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Australia/Melbourne", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const melDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date());
      const melNow = melFmt.format(new Date());
      const hours = Math.max(0, Math.min(23, parseInt(q.hours, 10) || 0));
      const midnight = `${melDate} 00:00:00`, back = melFmt.format(new Date(Date.now() - hours * 3600e3));
      const start = hours && back < midnight ? back : midnight;   // "YYYY-MM-DD HH:MM:SS" compares as text
      const hp = new URLSearchParams({
        application_key: APPLICATION_KEY, api_key: apiKey, mac: MAC,
        start_date: start, end_date: melNow, cycle_type: "5min",
        call_back: "outdoor.temperature,outdoor.humidity,outdoor.feels_like,wind.wind_speed,wind.wind_gust,wind.wind_direction,rainfall_piezo.rain_rate,rainfall_piezo.daily,rainfall.rain_rate,rainfall.daily,pressure.relative,solar_and_uvi.solar,solar_and_uvi.uvi,indoor.temperature",
        temp_unitid: "1", pressure_unitid: "3", wind_speed_unitid: "7", rainfall_unitid: "12", solar_irradiance_unitid: "16",
      });
      const r = await fetch(`${ECOWITT_BASE}/device/history?${hp}`);
      const h = await r.json();
      if (h.code !== 0) throw new Error(`Ecowitt history error: ${h.msg}`);
      const d = h.data || {};
      // Each measure comes back as { unit, list: { "<unix seconds>": "<value>" } }
      const series = (o) => {
        const list = (o && o.list) || {};
        return Object.entries(list).map(([t, v]) => [Number(t) * 1000, parseFloat(v)])
          .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
      };
      const pick = (...cands) => cands.map(series).find(s => s.length) || [];
      const rain = d.rainfall_piezo && Object.keys(d.rainfall_piezo).length ? d.rainfall_piezo : (d.rainfall || {});
      return {
        statusCode: 200, headers: { ...headers, "Cache-Control": "public, max-age=300" },
        body: JSON.stringify({
          date: melDate, start,
          temperature: pick(d.outdoor?.temperature), humidity: pick(d.outdoor?.humidity), feelsLike: pick(d.outdoor?.feels_like),
          windSpeed: pick(d.wind?.wind_speed), windGust: pick(d.wind?.wind_gust), windDirection: pick(d.wind?.wind_direction),
          rainRate: pick(rain.rain_rate), rainDaily: pick(rain.daily),
          pressure: pick(d.pressure?.relative), solar: pick(d.solar_and_uvi?.solar), uvi: pick(d.solar_and_uvi?.uvi),
          indoorTemp: pick(d.indoor?.temperature),
          timestamp: new Date().toISOString(),
        }),
      };
    } catch (err) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
    }
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

    // Room sensors (Ecowitt WN31, channels 1-8). The v3 API reports each as
    // temp_and_humidity_chN { temperature, humidity } and its battery as
    // battery.temp_humidity_sensor_chN (0 = OK, 1 = low; a few sensors send volts).
    // Rule agreed with Matt: the sensor's channel = the room's iZone zone number,
    // so the channel to set is the "Zone N" shown on each Climate Control card.
    const battery = d.battery || {};
    const channels = [];
    const rooms = {};
    for (let ch = 1; ch <= 8; ch++) {
      const th = d[`temp_and_humidity_ch${ch}`];
      if (!th || !th.temperature) continue;
      const temp = num(th.temperature);
      if (temp == null) continue;
      const t = Number(th.temperature.time);
      const updated = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : null;
      const b = parseFloat(battery[`temp_humidity_sensor_ch${ch}`]?.value);
      const batteryLow = !Number.isFinite(b) ? null : (b > 1.5 ? b < 1.2 : b >= 1);
      const room = INSTALLED_CHANNELS.includes(ch) ? (CHANNEL_ROOMS[ch] || null) : null;
      const reading = { channel: ch, room, temp, humidity: num(th.humidity), updated, batteryLow };
      channels.push(reading);
      if (room) rooms[room] = { temp, humidity: reading.humidity, last_update_iso: updated, batteryLow, channel: ch, source: "ecowitt" };
    }
    // The Ecowitt gateway sits in the Lounge (Matt, 5 Nov), so its built-in indoor sensor is the
    // Lounge reading whenever no WN31 is on channel 1. A channel 1 sensor always wins.
    if (!rooms.lounge && payload.indoorTemp != null) {
      rooms.lounge = { temp: payload.indoorTemp, humidity: payload.indoorHumidity, last_update_iso: payload.stationTime,
        batteryLow: null, channel: null, source: "gateway" };
    }
    payload.channels = channels;
    payload.rooms = rooms;

    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
