// netlify/functions/tides.js
// Tide forecast for Dromana from the Open-Meteo Marine API (free, no key): hourly sea level
// (tide plus surge) for the nearest sea cell, which is mid Port Phillip Bay (about 12 km north).
// It's a global model, not the Bureau's official tide tables, so times can be out by a little;
// the Weather page says so and links to BoM.
//   GET /.netlify/functions/tides -> { series: [[iso, m], ...], events: [{ type, time, m }], cell }
const LAT = -38.32, LON = 144.96;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  try {
    const p = new URLSearchParams({ latitude: LAT, longitude: LON, hourly: "sea_level_height_msl",
      timezone: "Australia/Melbourne", past_days: "1", forecast_days: "4", cell_selection: "sea" });
    const r = await fetch(`https://marine-api.open-meteo.com/v1/marine?${p}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.error) throw new Error(j.reason || "Open-Meteo marine error");
    const t = j.hourly?.time || [], v = j.hourly?.sea_level_height_msl || [];
    const series = t.map((x, i) => [x, v[i]]).filter(([, m]) => typeof m === "number");
    // Highs and lows: turning points in the hourly heights, refined with a parabola through the
    // three points around each so the time lands between the hours
    const events = [];
    for (let i = 1; i < series.length - 1; i++) {
      const [a, b, c] = [series[i - 1][1], series[i][1], series[i + 1][1]];
      const high = b > a && b >= c, low = b < a && b <= c;
      if (!high && !low) continue;
      const den = a - 2 * b + c, off = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      const m = b - 0.25 * (a - c) * off;
      const at = new Date(series[i][0] + ":00Z").getTime() + off * 3600e3;   // local wall time kept as-is
      const iso = new Date(at).toISOString().slice(0, 16);
      events.push({ type: high ? "high" : "low", time: iso, m: Math.round(m * 100) / 100 });
    }
    return {
      statusCode: 200,
      headers: { ...headers, "Cache-Control": "public, max-age=10800" },
      body: JSON.stringify({ series, events, cell: { lat: j.latitude, lon: j.longitude }, source: "Open-Meteo Marine", timestamp: new Date().toISOString() }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
