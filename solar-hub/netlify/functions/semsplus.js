// netlify/functions/semsplus.js
// Historical energy totals from GoodWe SEMS+ (the portal the SEMS app moved to in 2026).
//   GET /.netlify/functions/semsplus?period=year&date=2026      -> one row per month of 2026
//   GET /.netlify/functions/semsplus?period=month&date=2026-10  -> one row per day of October 2026
//   GET /.netlify/functions/semsplus?period=day&date=2026-10-29 -> that day's totals
//   add &raw=1 to see the shape of the first SEMS+ answer (for checking the field mapping)
// Read-only, fixed endpoints only. Uses the same SEMS_EMAIL / SEMS_PASSWORD env vars as sems.js.
// Login, signing and the production endpoint follow the open-source goodwe-semsplus client
// (github.com/WestLabsAI/goodwe-semsplus): stations/production returns kWh and account-currency
// totals for the items asked for, over a start/end window.
const crypto = require("crypto");

// Login host by region; the account only exists in one of them
const SEMS_HOSTS = ["https://semsplus.goodwe.com", "https://au-semsplus.goodwe.com", "https://us-semsplus.goodwe.com"];
let SEMS_HOST = SEMS_HOSTS[0];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
// The login itself is signed with an empty token, as the SEMS+ web portal does
const EMPTY_TOKEN = { uid: "", timestamp: 0, token: "", client: "semsPlusWeb", version: "", language: "en" };
const gwHeaders = tok => ({ token: JSON.stringify(tok), "X-Signature": signature(tok), "Access-Control-Allow-Origin": "*", neutral: "0", currentLang: "en" });
const LOGIN_PATH = "/web/sems/sems-user/api/v1/auth/cross-login";
const GATEWAYS = ["https://au-gateway.semsportal.com", "https://eu-gateway.semsportal.com", "https://us-gateway.semsportal.com"];
const ITEMS = ["proSystemTotalStats", "proGridStats", "proPurchaseStats", "proConsumStats", "profitProStats", "profitGridStats"];
const TZ = "Australia/Melbourne";

const md5b64 = (s) => Buffer.from(crypto.createHash("md5").update(s).digest("hex")).toString("base64");
function signature(tok) {
  const ts = Date.now();
  const h = crypto.createHash("sha256").update(`${ts}@${tok.uid || ""}@${tok.token || ""}`).digest("hex");
  return Buffer.from(`${h}@${ts}`).toString("base64");
}

let cached = null;   // { tok, gateway, stationId, at } kept while the function stays warm

async function loginAt(host, email, password) {
  const home = await fetch(host, { redirect: "follow", headers: { "User-Agent": UA } }).catch(() => null);
  const cookie = home ? (home.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ") : "";
  const r = await fetch(host + LOGIN_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", "User-Agent": UA, Origin: host, Referer: host + "/", ...gwHeaders(EMPTY_TOKEN), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ account: email, pwd: md5b64(password), agreement: 1, isChinese: false, isLocal: false }),
  });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { code: `http ${r.status}`, msg: t.slice(0, 60) }; }
  return j;
}
async function login(email, password) {
  const tried = [];
  for (const host of SEMS_HOSTS) {
    let j; try { j = await loginAt(host, email, password); } catch (e) { tried.push(`${host.replace("https://", "")}: ${e.message.slice(0, 60)}`); continue; }
    const code = j.code ?? j.status;
    if ([0, 200, "0", "00000", "200"].includes(code) && j.data) {
      SEMS_HOST = host;
      const tok = { ...(j.data || {}), client: "semsPlusWeb" };
      // The login may name this account's API gateway; otherwise try the known ones
      const hinted = [tok.api, tok.gateway, tok.apiUrl, j.api].filter(v => typeof v === "string" && v.startsWith("http")).map(v => v.replace(/\/+$/, "").replace(/\/web\/sems.*$/, "").replace(/\/api$/, ""));
      return { tok, gateways: [...new Set([...hinted, ...GATEWAYS])] };
    }
    tried.push(`${host.replace("https://", "")}: ${code} ${j.msg || j.message || ""}`.trim());
  }
  throw new Error("SEMS+ login failed (" + tried.join("; ") + ")");
}

async function call(gateway, tok, method, path, body) {
  const r = await fetch(gateway + "/web/sems" + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", "User-Agent": UA, Origin: SEMS_HOST, Referer: SEMS_HOST + "/", ...gwHeaders(tok) },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error(`${path} ${r.status}: ${t.slice(0, 120)}`); }
  return j;
}

async function session(email, password) {
  if (cached && Date.now() - cached.at < 20 * 60e3) return cached;
  const { tok, gateways } = await login(email, password);
  const tried = [];
  for (const gw of gateways) {
    try {
      const j = await call(gw, tok, "POST", "/sems-plant/api/stations/simple-query", { pageIndex: 1, pageSize: 20 });
      const list = (j.data && (j.data.dataList || j.data.list)) || [];
      tried.push(`${gw.replace("https://", "")}: ${j.code ?? j.status} ${list.length}`);
      if (list.length) {
        const st = list[0];
        cached = { tok, gateway: gw, stationId: st.id || st.stationId || st.powerStationId, stationName: st.name || st.stationName, at: Date.now() };
        return cached;
      }
    } catch (e) { tried.push(`${gw.replace("https://", "")}: ${e.message.slice(0, 80)}`); }
  }
  throw new Error("No SEMS+ station found (" + tried.join("; ") + ")");
}

// Pull a kWh / money number out of whatever shape an item comes back in
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  if (typeof v === "object") for (const k of ["value", "total", "val", "num", "data"]) { const n = num(v[k]); if (n != null) return n; }
  return null;
}
const pad = n => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

async function production(s, dimension, start, end) {
  const j = await call(s.gateway, s.tok, "POST", "/sems-plant/api/stations/production",
    { stationId: s.stationId, items: ITEMS, dimension, isReport: false, startTime: start, endTime: end });
  return j;
}
// Map the production answer onto our names. Items come back keyed by their code (or as a list
// of {item/key, value}); each may hold a figure for the window.
function mapRow(data) {
  const d = data && data.data !== undefined ? data.data : data;
  const get = (code) => {
    if (!d) return null;
    if (Array.isArray(d)) { const x = d.find(e => e && (e.item === code || e.key === code || e.code === code)); return x ? num(x) : null; }
    return num(d[code]);
  };
  return {
    gen_kwh: get("proSystemTotalStats"),
    export_kwh: get("proGridStats"),
    import_kwh: get("proPurchaseStats"),
    use_kwh: get("proConsumStats"),
    gen_income: get("profitProStats"),
    export_income: get("profitGridStats"),
  };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const email = process.env.SEMS_EMAIL, password = process.env.SEMS_PASSWORD;
  if (!email || !password) return { statusCode: 500, headers, body: JSON.stringify({ error: "SEMS_EMAIL or SEMS_PASSWORD env vars not set" }) };

  const q = event.queryStringParameters || {};
  const period = q.period, date = String(q.date || "");
  const ok = (period === "year" && /^20\d\d$/.test(date)) || (period === "month" && /^20\d\d-(0[1-9]|1[0-2])$/.test(date)) || (period === "day" && /^20\d\d-\d\d-\d\d$/.test(date));
  if (!ok) return { statusCode: 400, headers, body: JSON.stringify({ error: "period=year&date=YYYY, period=month&date=YYYY-MM or period=day&date=YYYY-MM-DD" }) };

  try {
    const s = await session(email, password);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const [y, m] = date.split("-").map(Number);
    // Windows to ask for: months of a year, days of a month, or the one day (none in the future)
    let wins = [];
    if (period === "year") for (let i = 1; i <= 12; i++) { const k = `${y}-${pad(i)}`; if (k <= today.slice(0, 7)) wins.push({ key: k, dim: "month", start: `${k}-01 00:00:00`, end: `${k}-${pad(lastDay(y, i))} 23:59:59` }); }
    if (period === "month") for (let i = 1; i <= lastDay(y, m); i++) { const k = `${date}-${pad(i)}`; if (k <= today) wins.push({ key: k, dim: "day", start: `${k} 00:00:00`, end: `${k} 23:59:59` }); }
    if (period === "day") wins = [{ key: date, dim: "day", start: `${date} 00:00:00`, end: `${date} 23:59:59` }];

    if (q.raw) {
      const j = await production(s, wins[0].dim, wins[0].start, wins[0].end);
      const shape = (v, d = 0) => Array.isArray(v) ? (d > 3 ? `[${v.length}]` : v.slice(0, 3).map(x => shape(x, d + 1)))
        : v && typeof v === "object" ? (d > 3 ? "{..}" : Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, shape(x, d + 1)]))) : v;
      return { statusCode: 200, headers, body: JSON.stringify({ gateway: s.gateway, station: s.stationName, window: wins[0], code: j.code ?? j.status, msg: j.msg, data: shape(j.data) }) };
    }

    const rows = [];
    for (let i = 0; i < wins.length; i += 6) {   // a few at a time so SEMS+ isn't hammered
      const batch = await Promise.all(wins.slice(i, i + 6).map(async w => {
        const j = await production(s, w.dim, w.start, w.end);
        return { key: w.key, code: j.code ?? j.status, ...mapRow(j.data) };
      }));
      rows.push(...batch);
    }
    // Finished periods never change, so let the CDN keep them; the current one refreshes every 10 min
    const current = period === "day" ? date === today : period === "month" ? date === today.slice(0, 7) : date === today.slice(0, 4);
    return {
      statusCode: 200,
      headers: { ...headers, "Cache-Control": current ? "public, max-age=600" : "public, max-age=86400" },
      body: JSON.stringify({ period, date, station: s.stationName, currency: "AUD", rows, timestamp: new Date().toISOString() }),
    };
  } catch (err) {
    cached = null;
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
