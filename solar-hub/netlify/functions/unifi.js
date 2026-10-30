// netlify/functions/unifi.js
// Internet and network status from UniFi Site Manager (cloud API, read-only).
// Matt's site: one UniFi Dream Router (UDR), Aussie Broadband.
//   GET /.netlify/functions/unifi -> { online, isp, latencyMs, downMbps, upMbps, packetLoss,
//                                      wanUptime, clients, devices, history[...] }
// Needs Netlify env var UNIFI_API_KEY (unifi.ui.com > Settings > API). Never put the key in code.
const BASE = "https://api.ui.com";

exports.handler = async () => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" };
  const key = process.env.UNIFI_API_KEY;
  if (!key) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "UNIFI_API_KEY env var not set in Netlify" }) };
  }
  const h = { "X-API-KEY": key, Accept: "application/json" };
  const get = (path, ms) => fetch(BASE + path, { headers: h, signal: AbortSignal.timeout(ms) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} HTTP ${r.status} ${j.message || ""}`); return j; });
  try {
    // ISP metrics are an early-access endpoint; don't let them sink the whole response
    const [sites, isp] = await Promise.all([
      get("/v1/sites", 15000),
      get("/ea/isp-metrics/5m?duration=24h", 20000).catch(() => ({})),
    ]);
    const site = (sites.data || [])[0];
    if (!site) throw new Error("No UniFi site on this account");
    const st = site.statistics || {}, c = st.counts || {}, wan = Object.values(st.wans || {})[0] || {};
    const periods = ((isp.data || [])[0] || {}).periods || [];
    const w = p => ((p || {}).data || {}).wan || {};
    const last = w(periods[periods.length - 1]);
    const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const issues = (st.internetIssues || []).length + (wan.wanIssues || []).length;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        online: wan.portUp !== false && !c.offlineGatewayDevice,
        issues,
        isp: (st.ispInfo || wan.ispInfo || {}).name || null,
        gateway: (st.gateway || {}).shortname || null,
        wanUptime: num((st.percentages || {}).wanUptime),
        latencyMs: num(last.avgLatency),
        maxLatencyMs: num(last.maxLatency),
        downMbps: num(last.download_kbps) != null ? last.download_kbps / 1000 : null,
        upMbps: num(last.upload_kbps) != null ? last.upload_kbps / 1000 : null,
        packetLoss: num(last.packetLoss),
        metricTime: (periods[periods.length - 1] || {}).metricTime || null,
        clients: { wifi: c.wifiClient || 0, wired: c.wiredClient || 0, guest: c.guestClient || 0 },
        devices: { total: c.totalDevice || 0, offline: c.offlineDevice || 0 },
        history: periods.map(p => ({ t: p.metricTime, down: num(w(p).download_kbps), up: num(w(p).upload_kbps), lat: num(w(p).avgLatency), loss: num(w(p).packetLoss) })),
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "UniFi unreachable: " + err.message }) };
  }
};
