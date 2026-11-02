// netlify/functions/travel.js
// Driving time from home to an appointment's location, for the dashboard's "Next up".
//   GET /.netlify/functions/travel?q=<location text from the calendar event>
//   -> { place, km, mins }   (mins: typical free-flowing drive, no live traffic)
// Free, keyless OpenStreetMap services: Nominatim finds the place (biased to Victoria, Australia),
// the OSRM demo router gives the drive. Each answer is cached by the CDN for 30 days, so a regular
// appointment (piano, swimming) is looked up once. Same dashboard key as the calendar (HUB_TOKEN).
const crypto = require("crypto");

const HOME = { lat: -38.33, lon: 144.97 };   // Dromana, the same point the forecast and radar use
const UA = "HomeDashboard/1.0 (solarhubdromana.netlify.app)";   // Nominatim asks every app to identify itself

function authorised(event) {
  const want = process.env.HUB_TOKEN;
  if (!want) return true;
  const got = event.headers?.["x-hub-token"] || "";
  const a = Buffer.from(String(got)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function geocode(q) {
  const tries = [q, /victoria|vic\b|australia/i.test(q) ? null : `${q}, Victoria, Australia`].filter(Boolean);
  for (const t of tries) {
    const p = new URLSearchParams({ format: "jsonv2", limit: "1", countrycodes: "au", q: t,
      viewbox: "143.6,-37.2,146.4,-39.0", bounded: "0", "accept-language": "en" });
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) continue;
    const j = await r.json();
    if (Array.isArray(j) && j.length) return { lat: +j[0].lat, lon: +j[0].lon, name: j[0].name || j[0].display_name };
  }
  return null;
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (!authorised(event)) return { statusCode: 401, headers, body: JSON.stringify({ error: "Locked. This device needs the dashboard key." }) };
  const q = String((event.queryStringParameters || {}).q || "").trim().replace(/\s+/g, " ");
  if (!q || q.length > 200) return { statusCode: 400, headers, body: JSON.stringify({ error: "q (the event location) is required, up to 200 characters" }) };
  // Online meetings have no drive
  if (/https?:\/\/|zoom\.us|teams\.microsoft|meet\.google|webex/i.test(q)) return { statusCode: 200, headers, body: JSON.stringify({ online: true }) };
  try {
    const to = await geocode(q);
    if (!to) return { statusCode: 200, headers: { ...headers, "Cache-Control": "public, max-age=86400" }, body: JSON.stringify({ found: false }) };
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${HOME.lon},${HOME.lat};${to.lon},${to.lat}?overview=false`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const rt = j.routes && j.routes[0];
    if (!rt) return { statusCode: 200, headers, body: JSON.stringify({ found: true, place: to.name, routed: false }) };
    return {
      statusCode: 200,
      headers: { ...headers, "Cache-Control": "public, max-age=2592000" },
      body: JSON.stringify({ found: true, place: to.name, km: Math.round(rt.distance / 100) / 10, mins: Math.max(1, Math.round(rt.duration / 60)) }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
