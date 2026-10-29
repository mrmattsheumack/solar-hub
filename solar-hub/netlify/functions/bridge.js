// netlify/functions/bridge.js
// Same-origin proxy from Solar Hub (index.html) to the Pi bridge, so the browser
// never holds the bridge key. Only the bridge's existing iZone/sensor/health
// routes are allowed through.
//   /.netlify/functions/bridge?p=/api/izone/query   (POST)
//   /.netlify/functions/bridge?p=/api/izone/command (POST)
//   /.netlify/functions/bridge?p=/api/izone/zones   (POST)
//   /.netlify/functions/bridge?p=/api/sensors/temps (GET)
//   /.netlify/functions/bridge?p=/health            (GET)
// Needs Netlify env var BRIDGE_TOKEN (same as BEARER_TOKEN in the Pi's .env).
const BRIDGE_URL = process.env.BRIDGE_URL || "https://eaglecam.taile03fa1.ts.net";
const ALLOWED = {
  "/api/izone/query": "POST",
  "/api/izone/command": "POST",
  "/api/izone/zones": "POST",
  "/api/sensors/temps": "GET",
  "/health": "GET",
};

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const path = (event.queryStringParameters || {}).p || "";
  const method = ALLOWED[path];
  if (!method) return { statusCode: 404, headers, body: JSON.stringify({ error: "unknown bridge path" }) };
  if (event.httpMethod !== method) return { statusCode: 405, headers, body: JSON.stringify({ error: `${path} expects ${method}` }) };
  const token = process.env.BRIDGE_TOKEN;
  if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: "BRIDGE_TOKEN env var not set in Netlify" }) };
  try {
    const res = await fetch(BRIDGE_URL + path, {
      method,
      headers: { Authorization: "Bearer " + token, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? (event.body || "{}") : undefined,
      signal: AbortSignal.timeout(path === "/api/izone/zones" ? 15000 : 9000),
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...headers, "Content-Type": res.headers.get("content-type") || "application/json" }, body: text };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Pi bridge unreachable: " + err.message }) };
  }
};
