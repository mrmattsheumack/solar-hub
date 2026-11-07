// pi/site-server/server.mjs: serves the Home Dashboard from the Pi instead of Netlify.
//
// - Static files from <SITE_DIR>/public (the same files Netlify published).
// - /.netlify/functions/<name>: runs the same function files from <SITE_DIR>/netlify/functions, unchanged.
//   Classic handlers (exports.handler(event) -> { statusCode, headers, body }) and the newer style
//   (export default (Request, context) -> Response) both work.
// - A small in-memory cache that copies what Netlify's CDN did: a 200 GET response marked
//   "public, max-age=N" is reused for N seconds, and identical requests in flight share one call
//   (keeps SEMS, Ecowitt and friends from being asked twice).
// - Scheduled functions (export const config = { schedule: "*/5 * * * *" }) run on that schedule.
// - Netlify Blobs: the climate functions use a file-backed store when SITE_STORE_DIR is set
//   (see netlify/blobs.mjs).
//
// Env (systemd EnvironmentFile): the same variables the Netlify site had, plus
//   SITE_DIR        checkout of the repo's solar-hub/ folder      (default: ../../solar-hub next to this file)
//   PORT            listen port, localhost only                    (default 8100)
//   SITE_URL        what functions see as the site's own address   (default http://127.0.0.1:PORT)
//   SITE_STORE_DIR  where blob stores are kept                     (default ~/solar-hub-site-data)
// No dependencies beyond Node 18+.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(HERE, "../../solar-hub"));
const PUBLIC = path.join(SITE_DIR, "public");
const FUNCS = path.join(SITE_DIR, "netlify/functions");
const PORT = Number(process.env.PORT || 8100);
const HOST = process.env.HOST || "127.0.0.1";
const SITE_URL = process.env.SITE_URL || `http://127.0.0.1:${PORT}`;
process.env.SITE_STORE_DIR ||= path.join(os.homedir(), "solar-hub-site-data");
process.env.URL ||= SITE_URL;
globalThis.Netlify ||= { env: { get: k => process.env[k], has: k => k in process.env } };
const FN_TIMEOUT_MS = 30000;
const require = createRequire(import.meta.url);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
  ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".woff2": "font/woff2",
};
const REDIRECTS = { "/home.html": "/" };   // from netlify.toml

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- functions ----------
const fnCache = new Map();
function fnFile(name) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) return null;
  for (const ext of [".js", ".mjs", ".cjs"]) { const f = path.join(FUNCS, name + ext); if (fs.existsSync(f)) return f; }
  return null;
}
async function loadFn(name) {
  if (fnCache.has(name)) return fnCache.get(name);
  const file = fnFile(name); if (!file) return null;
  let mod;
  if (file.endsWith(".mjs")) mod = await import(pathToFileURL(file).href);
  else mod = require(file);
  const fn = { name, file, handler: mod.handler || mod.default?.handler, modern: !mod.handler && typeof mod.default === "function" ? mod.default : null, config: mod.config || mod.default?.config };
  fnCache.set(name, fn);
  return fn;
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms))]);

// Runs a function and returns { status, headers, body: Buffer }
async function callFn(fn, { method, url, headers, body }) {
  const u = new URL(url, SITE_URL);
  if (fn.modern) {
    const req = new Request(u, { method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : body });
    const res = await withTimeout(Promise.resolve(fn.modern(req, { site: { url: SITE_URL }, geo: {}, ip: headers["x-forwarded-for"] || "" })), FN_TIMEOUT_MS, fn.name);
    const r = res instanceof Response ? res : new Response(res == null ? "" : String(res));
    return { status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) };
  }
  const qs = Object.fromEntries(u.searchParams), mqs = {};
  for (const k of u.searchParams.keys()) mqs[k] = u.searchParams.getAll(k);
  const event = {
    httpMethod: method, path: u.pathname, rawUrl: u.href, rawQuery: u.search.slice(1),
    headers, multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
    queryStringParameters: qs, multiValueQueryStringParameters: mqs,
    body: body && body.length ? body.toString("utf8") : null, isBase64Encoded: false,
  };
  const r = await withTimeout(Promise.resolve(fn.handler(event, { functionName: fn.name })), FN_TIMEOUT_MS, fn.name) || {};
  const h = { ...(r.headers || {}) };
  for (const [k, v] of Object.entries(r.multiValueHeaders || {})) h[k] = Array.isArray(v) ? v.join(", ") : v;
  const b = r.body == null ? Buffer.alloc(0) : r.isBase64Encoded ? Buffer.from(r.body, "base64") : Buffer.from(String(r.body));
  return { status: r.statusCode || 200, headers: h, body: b };
}

// ---------- CDN-like cache ----------
const cache = new Map(), inflight = new Map();
function maxAge(headers) {
  const get = k => Object.entries(headers).find(([n]) => n.toLowerCase() === k)?.[1] || "";
  const cc = String(get("netlify-cdn-cache-control") || get("cdn-cache-control") || get("cache-control")).toLowerCase();
  if (!cc.includes("public") || /no-store|private|no-cache/.test(cc)) return 0;
  const m = cc.match(/s-maxage=(\d+)/) || cc.match(/max-age=(\d+)/);
  return m ? Number(m[1]) : 0;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of cache) if (v.until < now) cache.delete(k); }, 60e3).unref();

async function serveFn(name, req, res, body) {
  const fn = await loadFn(name).catch(e => { log("load failed", name, e); return { error: e }; });
  if (!fn) return send(res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "no such function" }));
  if (fn.error) return send(res, 500, { "Content-Type": "application/json" }, JSON.stringify({ error: "function failed to load" }));
  const headers = { ...req.headers, "x-forwarded-for": req.headers["x-forwarded-for"] || req.socket.remoteAddress || "" };
  const tok = headers["x-hub-token"] ? crypto.createHash("sha256").update(String(headers["x-hub-token"])).digest("hex").slice(0, 12) : "";
  const key = req.method === "GET" ? req.url + "|" + tok : null;
  if (key) {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return send(res, hit.status, { ...hit.headers, "x-site-cache": "hit" }, hit.body);
    if (inflight.has(key)) { const r = await inflight.get(key); return send(res, r.status, { ...r.headers, "x-site-cache": "shared" }, r.body); }
  }
  const t0 = Date.now();
  const p = callFn(fn, { method: req.method, url: req.url, headers, body }).catch(e => {
    log("function error", name, e?.stack || e);
    return { status: 502, headers: { "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify({ error: String(e?.message || e) })) };
  });
  if (key) inflight.set(key, p);
  const r = await p;
  if (key) {
    inflight.delete(key);
    const age = r.status === 200 ? maxAge(r.headers) : 0;
    if (age > 0) cache.set(key, { ...r, until: Date.now() + age * 1000 });
  }
  if (Date.now() - t0 > 8000) log("slow", name, Date.now() - t0, "ms");
  send(res, r.status, r.headers, r.body);
}

// ---------- static ----------
async function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, SITE_URL).pathname); } catch { return send(res, 400, {}, "bad path"); }
  if (REDIRECTS[p]) return send(res, 301, { Location: REDIRECTS[p] }, "");
  let file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, {}, "no");
  try {
    let st = await fsp.stat(file);
    if (st.isDirectory()) { file = path.join(file, "index.html"); st = await fsp.stat(file); }
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const h = { "Content-Type": MIME[ext] || "application/octet-stream", ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" };
    if (req.headers["if-none-match"] === etag) return send(res, 304, h, "");
    send(res, 200, h, req.method === "HEAD" ? "" : await fsp.readFile(file));
  } catch {
    const nf = path.join(PUBLIC, "404.html");
    send(res, 404, { "Content-Type": "text/html; charset=utf-8" }, fs.existsSync(nf) ? fs.readFileSync(nf) : "Not found");
  }
}

function send(res, status, headers, body) {
  if (res.headersSent) return;
  const h = { "Access-Control-Allow-Origin": "*", ...headers };
  delete h["content-length"]; delete h["Content-Length"]; delete h["transfer-encoding"];
  res.writeHead(status, h); res.end(body);
}

const server = http.createServer((req, res) => {
  const chunks = []; let size = 0;
  req.on("data", c => { size += c.length; if (size > 6e6) { send(res, 413, {}, "too big"); req.destroy(); } else chunks.push(c); });
  req.on("end", async () => {
    try {
      const m = req.url.match(/^\/\.netlify\/functions\/([^/?#]+)/);
      if (req.method === "OPTIONS") return send(res, 204, { "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-hub-token" }, "");
      if (m) return await serveFn(m[1], req, res, Buffer.concat(chunks));
      if (!["GET", "HEAD"].includes(req.method)) return send(res, 405, {}, "GET only");
      return await serveStatic(req, res);
    } catch (e) { log("request failed", req.url, e); send(res, 500, {}, "server error"); }
  });
});

// ---------- schedules (only "*/N * * * *" and "@hourly" style minute schedules are needed) ----------
async function startSchedules() {
  for (const f of fs.readdirSync(FUNCS)) {
    const name = f.replace(/\.(m|c)?js$/, ""); if (name === f) continue;
    let fn; try { fn = await loadFn(name); } catch (e) { log("load failed", name, e.message); continue; }
    const s = fn?.config?.schedule; if (!s) continue;
    const every = s === "@hourly" ? 60 : Number((s.match(/^\*\/(\d+) \* \* \* \*$/) || [])[1]);
    if (!every) { log("schedule not understood, skipped:", name, s); continue; }
    log("schedule", name, "every", every, "min");
    const tick = async () => {
      try { const r = await callFn(fn, { method: "POST", url: `/.netlify/functions/${name}`, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ next_run: null })) }); if (r.status >= 400) log("scheduled", name, "HTTP", r.status); }
      catch (e) { log("scheduled", name, "failed", e.message); }
    };
    // line up with the clock like cron does
    const ms = every * 60e3, wait = ms - (Date.now() % ms) + 2000;
    setTimeout(() => { tick(); setInterval(tick, ms); }, wait);
  }
}

server.listen(PORT, HOST, () => { log(`Home Dashboard on http://${HOST}:${PORT} from ${SITE_DIR}`); startSchedules(); });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
