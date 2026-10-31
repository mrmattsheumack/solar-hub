// netlify/functions/calendar.js
// The family Google Calendar for the dashboard (upcoming events) and the Calendar page.
// Reads the calendar as a Google service account that the calendar has been shared with, so no
// one has to sign in and no Google tokens ever reach the browser.
//
//   GET /.netlify/functions/calendar                       -> today + the next 14 days
//   GET /.netlify/functions/calendar?from=2026-11-01&to=2026-12-01   (Melbourne dates, `to` exclusive)
//   -> { calendar, timezone, from, to, events: [{ id, title, start, end, allDay, location, notes, recurring, color, link }] }
//
// Recurring events come back already expanded into single occurrences (singleEvents=true), with
// moved or cancelled occurrences handled by Google, so the page never has to do RRULE maths.
//
// Netlify env vars:
//   FAMILY_CAL_ID   calendar ID (Google Calendar > calendar settings > Integrate calendar)
//   GOOGLE_SA_KEY   the service account's JSON key, pasted whole
//                   (or GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY if the whole key is too big for the 4 KB limit)
//   HUB_TOKEN       optional. When set, callers must send it in the x-hub-token header.
// No npm dependencies: the Google sign-in (a signed JWT) is done with Node's crypto.
const crypto = require("crypto");

const TZ = "Australia/Melbourne";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const MAX_DAYS = 100;

let cachedToken = null;   // { token, exp } kept between warm invocations

function serviceAccount() {
  if (process.env.GOOGLE_SA_KEY) {
    const k = JSON.parse(process.env.GOOGLE_SA_KEY);
    return { email: k.client_email, key: k.private_key };
  }
  if (process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY) {
    return { email: process.env.GOOGLE_SA_EMAIL, key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n") };
  }
  throw new Error("GOOGLE_SA_KEY env var not set in Netlify");
}

const b64url = buf => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60e3) return cachedToken.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Google sign-in failed: " + (j.error_description || j.error || "HTTP " + r.status));
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// ---------- Melbourne dates ----------
const ymd = d => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
// Minutes Melbourne is ahead of UTC at a given instant (600 or 660)
function tzOffset(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(at).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at.getTime() / 60000) * 60000) / 60000;
}
// Midnight at the start of a Melbourne date, as an instant
function melMidnight(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d) - 600 * 60000);
  return new Date(Date.UTC(y, m - 1, d) - tzOffset(guess) * 60000);
}
const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

function authorised(event) {
  const want = process.env.HUB_TOKEN;
  if (!want) return true;
  const got = event.headers?.["x-hub-token"] || "";
  const a = Buffer.from(String(got)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async event => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };
  if (!authorised(event)) return { statusCode: 401, headers, body: JSON.stringify({ error: "Locked. This device needs the dashboard key." }) };
  const calId = process.env.FAMILY_CAL_ID;
  if (!calId) return { statusCode: 500, headers, body: JSON.stringify({ error: "FAMILY_CAL_ID env var not set in Netlify" }) };

  const q = event.queryStringParameters || {};
  const from = isDate(q.from) ? q.from : ymd(new Date());
  let to = isDate(q.to) ? q.to : addDays(from, 15);
  if (to <= from) to = addDays(from, 1);
  if (melMidnight(to) - melMidnight(from) > MAX_DAYS * 86400e3) to = addDays(from, MAX_DAYS);

  try {
    const token = await accessToken();
    const events = [];
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const p = new URLSearchParams({
        singleEvents: "true", orderBy: "startTime", timeZone: TZ, maxResults: "250",
        timeMin: melMidnight(from).toISOString(), timeMax: melMidnight(to).toISOString(),
      });
      if (pageToken) p.set("pageToken", pageToken);
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${p}`, {
        headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(12000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404 || r.status === 403) throw new Error("The dashboard's Google account can't see this calendar. Check it's still shared with the service account.");
      if (!r.ok) throw new Error("Google Calendar: " + (j.error?.message || "HTTP " + r.status));
      for (const e of j.items || []) {
        if (e.status === "cancelled") continue;
        const allDay = !!e.start?.date;
        events.push({
          id: e.id,
          title: e.summary || "(no title)",
          start: allDay ? e.start.date : e.start?.dateTime,   // all-day: 2026-11-03; timed: 2026-11-03T15:30:00+11:00
          end: allDay ? e.end?.date : e.end?.dateTime,        // all-day end is exclusive (the day after)
          allDay,
          location: e.location || null,
          notes: e.description ? String(e.description).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280) : null,
          recurring: !!e.recurringEventId,
          color: e.colorId || null,
          link: e.htmlLink || null,
        });
      }
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    return { statusCode: 200, headers, body: JSON.stringify({ calendar: "Family", timezone: TZ, from, to, events, timestamp: new Date().toISOString() }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
