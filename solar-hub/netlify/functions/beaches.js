// netlify/functions/beaches.js
// Beach water quality near home from EPA Victoria (the same feed their "Check air and water quality"
// map uses). EPA forecasts each site Good / Fair / Poor, mostly from recent or forecast rain.
//   GET /.netlify/functions/beaches -> { sites: [{ name, advice, reason, updated, km, url }] }
const FEED = "https://www.epa.vic.gov.au/api/environment/water/sites";
const HOME = [-38.317417, 144.96895];          // Dromana foreshore (the point Matt's EPA link centres on)
const MAX_KM = 8, MAX_SITES = 4;

const toRad = d => d * Math.PI / 180;
const km = (a, b, c, d) => 12742 * Math.asin(Math.sqrt(Math.sin(toRad(c - a) / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(toRad(d - b) / 2) ** 2));

exports.handler = async () => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" };
  try {
    const r = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0 (Solar Hub home dashboard)", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("EPA HTTP " + r.status);
    const all = await r.json();
    if (!Array.isArray(all)) throw new Error("EPA returned no site list");
    const sites = all
      .map(s => ({ s, d: km(HOME[0], HOME[1], parseFloat(s.lat), parseFloat(s.lng)) }))
      .filter(x => Number.isFinite(x.d) && x.d <= MAX_KM)
      .sort((a, b) => a.d - b.d).slice(0, MAX_SITES)
      .map(({ s, d }) => ({
        id: s.id, name: s.siteName, type: s.siteType || null,
        advice: s.healthAdvice || null,                                       // Good | Fair | Poor (or null out of season)
        reason: String(s.healthAdviceReason || "").split(". ").slice(0, 2).join(". ").replace(/\.?$/, "."),
        updated: s.updated || null, km: Math.round(d * 10) / 10,
        url: `https://www.epa.vic.gov.au/check-air-and-water-quality?lat=${s.lat}&lon=${s.lng}&z=14`,
      }));
    return { statusCode: 200, headers, body: JSON.stringify({ sites, timestamp: new Date().toISOString() }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "EPA water quality unreachable: " + err.message }) };
  }
};
