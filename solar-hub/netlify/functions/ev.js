// netlify/functions/ev.js
// Same-origin proxy for the EV charging page. The browser never talks to the Pi
// directly (Chrome blocks public pages calling a Tailscale/private address, and
// this keeps the bridge token out of the page). Netlify calls the Pi's Funnel URL.
//   GET  /.netlify/functions/ev            -> bridge GET  /api/ev/state
//   GET  /.netlify/functions/ev?view=history -> bridge GET /api/ev/history (one row per day)
//   POST /.netlify/functions/ev {mode?, offpeak?} -> bridge POST /api/ev/mode
// Needs Netlify env var BRIDGE_TOKEN (same value as BEARER_TOKEN in the Pi's .env), set 2026-10-30.
const BRIDGE_URL = process.env.BRIDGE_URL || "https://eaglecam.taile03fa1.ts.net";

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const token = process.env.BRIDGE_TOKEN;
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "BRIDGE_TOKEN env var not set in Netlify" }) };
  }
  const auth = { Authorization: "Bearer " + token };
  try {
    let res;
    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch (e) {}
      const out = {};
      if (body.mode !== undefined) {
        if (!["auto", "full", "off"].includes(body.mode)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "mode must be auto, full or off" }) };
        }
        out.mode = body.mode;
      }
      if (body.offpeak !== undefined) {
        if (typeof body.offpeak !== "boolean") {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "offpeak must be true or false" }) };
        }
        out.offpeak = body.offpeak;
      }
      if (!Object.keys(out).length) return { statusCode: 400, headers, body: JSON.stringify({ error: "send mode and/or offpeak" }) };
      res = await fetch(BRIDGE_URL + "/api/ev/mode", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(out),
        signal: AbortSignal.timeout(10000),
      });
    } else if (event.httpMethod === "GET") {
      const view = (event.queryStringParameters || {}).view;
      const path = view === "history" ? "/api/ev/history" : "/api/ev/state";
      res = await fetch(BRIDGE_URL + path, { headers: auth, signal: AbortSignal.timeout(15000) });
    } else {
      return { statusCode: 405, headers, body: JSON.stringify({ error: "GET or POST only" }) };
    }
    const text = await res.text();
    return { statusCode: res.status, headers, body: text };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Pi bridge unreachable: " + err.message }) };
  }
};
