// netlify/functions/warnings.js
// Official warnings and incidents that affect home, from the VicEmergency public feed (which carries
// BoM weather warnings, CFA/FRV fires, floods, EMV advice and planned burns, each with a map area).
//   GET /.netlify/functions/warnings -> { items: [{ title, kind, level, location, headline, distanceKm, updated, url }] }
// A warning counts if its area covers Dromana (or it's statewide). A point incident counts if it's close.
const FEED = "https://emergency.vic.gov.au/public/events-geojson.json";
const HOME = (process.env.WARN_TEST_HOME || "144.97,-38.33").split(",").map(Number);   // lon, lat (forecast point); env only for testing
const NEAR_KM = { default: 15, "Planned Burn": 8 };

const toRad = d => d * Math.PI / 180;
function km([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (p, rings) => inRing(p, rings[0]) && !rings.slice(1).some(h => inRing(p, h));
function geoms(g) {
  if (!g) return [];
  return g.type === "GeometryCollection" ? g.geometries.flatMap(geoms) : [g];
}
// Does the feature's area cover home, and how far is its nearest point?
function where(f) {
  let covers = false, dist = Infinity;
  for (const g of geoms(f.geometry)) {
    if (g.type === "Polygon" && inPolygon(HOME, g.coordinates)) covers = true;
    if (g.type === "MultiPolygon" && g.coordinates.some(p => inPolygon(HOME, p))) covers = true;
    if (g.type === "Point") dist = Math.min(dist, km(HOME, g.coordinates));
  }
  return { covers, dist };
}
// emergency > watch > advice > info, mapped from VicEmergency's warning levels and BoM's headings
function level(p) {
  const t = `${p.category1 || ""} ${p.name || ""} ${p.sourceTitle || ""} ${p.status || ""}`.toLowerCase();
  if (t.includes("emergency warning") || t.includes("evacuat")) return "emergency";
  if (t.includes("watch and act") || t.includes("severe") || (p.sourceOrg === "AU/BOM" && t.includes("warning"))) return "watch";
  if (p.feedType === "warning" || t.includes("advice")) return "advice";
  return "info";
}
const RANK = { emergency: 3, watch: 2, advice: 1, info: 0 };
const strip = html => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

exports.handler = async () => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" };
  try {
    const r = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0 (Solar Hub home dashboard)", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("VicEmergency HTTP " + r.status);
    const d = await r.json();
    const items = [];
    for (const f of d.features || []) {
      const p = f.properties || {};
      if (/safe|complete|^closed/i.test(p.status || "")) continue;
      const { covers, dist } = where(f);
      const near = dist <= (NEAR_KM[p.category1] || NEAR_KM.default);
      const statewide = p.statewide === "Y";
      if (!(covers || near || statewide)) continue;
      const lv = level(p);
      const headline = (p.webHeadline ? strip(p.webHeadline) : strip(p.webBody)).slice(0, 220);
      items.push({
        id: String(p.id || p.sourceId),
        title: p.sourceTitle || p.name || p.category2 || "Warning",
        kind: [p.category1, p.category2].filter(Boolean).join(" · "),
        cap: p.cap ? p.cap.event : null,
        level: lv,
        location: p.location || null,
        headline,
        covers,
        distanceKm: Number.isFinite(dist) ? Math.round(dist * 10) / 10 : null,
        status: p.status || null,
        updated: p.updated || p.created || null,
        url: p.url || "https://emergency.vic.gov.au/respond/",
        source: p.sourceOrg || null,
      });
    }
    items.sort((a, b) => RANK[b.level] - RANK[a.level] || (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    return { statusCode: 200, headers, body: JSON.stringify({ items, checked: d.features ? d.features.length : 0, timestamp: new Date().toISOString() }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Warnings feed unreachable: " + err.message }) };
  }
};
