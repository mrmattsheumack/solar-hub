// netlify/functions/usage.js
// Queries solar_agl_usage table in Supabase for any date range
// Returns hourly aggregated data: solar_kwh, grid_kwh per interval

const SUPABASE_URL = "https://uzdfjlddgeoelltnprpb.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6ZGZqbGRkZ2VvZWxsdG5wcnBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyODc3NzIsImV4cCI6MjA4OTg2Mzc3Mn0.mqs_ho9NP3Igwls4tI1CV2LqGYNBD1MgDvSGfOx2xZc";

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const params = event.queryStringParameters || {};
  const { from, to, granularity = "30min" } = params;

  if (!from || !to) return {
    statusCode: 400, headers,
    body: JSON.stringify({ error: "from and to date params required (YYYY-MM-DD)" }),
  };

  try {
    // Fetch all rows in range from Supabase
    const url = `${SUPABASE_URL}/rest/v1/solar_agl_usage?start_time=gte.${from}T00:00:00&start_time=lte.${to}T23:59:59&order=start_time.asc&limit=50000`;
    const res = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
    });
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`Supabase error: ${JSON.stringify(rows)}`);

    // Aggregate based on granularity
    const buckets = {};
    for (const row of rows) {
      let key;
      const dt = new Date(row.start_time);
      if (granularity === "30min") {
        // HH:MM for single day view
        key = dt.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
      } else if (granularity === "day") {
        key = row.start_time.slice(0, 10);
      } else if (granularity === "week") {
        // Group by day within week
        key = row.start_time.slice(0, 10);
      } else if (granularity === "month") {
        key = row.start_time.slice(0, 10);
      } else if (granularity === "year") {
        // Group by month
        key = row.start_time.slice(0, 7); // YYYY-MM
      } else {
        key = row.start_time.slice(0, 10);
      }

      if (!buckets[key]) buckets[key] = { solar: 0, grid: 0, count: 0 };
      if (row.type === "Solar")       buckets[key].solar += row.kwh;
      if (row.type === "Generalusage") buckets[key].grid  += row.kwh;
      buckets[key].count++;
    }

    const result = Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0])).map(([time, v]) => ({
      time,
      solarKwh:   +v.solar.toFixed(3),
      gridKwh:    +v.grid.toFixed(3),
      selfUseKwh: 0, // calculated client-side based on context
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ data: result, rows: rows.length }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
