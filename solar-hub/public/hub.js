/* Solar Hub shared client code (dashboard, Weather and Energy pages).
   Each page puts the tiles it wants in its markup; every renderer here quietly skips tiles that
   aren't on the page. A page starts it with Hub.start({ sources, wall, extra }):
     sources: which feeds to poll (ev sems wx fc radar net warn climate wxhist evhist beach cal)
     wall:    true on the always-on dashboard (wake lock, night dim, burn-in shift, 6-hourly reload)
     extra:   page-specific render functions, run after every data refresh */
window.Hub = (() => {
  'use strict';

  // ---------- settings ----------
  const TZ = 'Australia/Melbourne';
  const HOME = [-38.33, 144.97];                       // same point the forecast function uses
  const RADAR_CENTRE = [-37.98, 144.92], RADAR_ZOOM = 8;   // Dromana, Melbourne and Geelong in view (pages can override on #map)
  const PANEL_KW = 13.2, PR = 0.65;                    // matches ev.html daily estimate
  const fcKw = ghi => Math.min(9.6, ghi / 1000 * PANEL_KW * 0.75);   // matches ev.html hourly curve
  const API = {
    ev: '/.netlify/functions/ev',
    sems: '/.netlify/functions/sems',
    wx: '/.netlify/functions/ecowitt',
    fc: '/.netlify/functions/forecast',
    radar: 'https://api.rainviewer.com/public/weather-maps.json',
    net: '/.netlify/functions/unifi',
    warn: '/.netlify/functions/warnings',
    wxhist: '/.netlify/functions/ecowitt?history=today',
    beach: '/.netlify/functions/beaches',
    evhist: '/.netlify/functions/ev?view=history',
    cal: '/.netlify/functions/calendar',
  };
  const EVERY = { ev: 30e3, wx: 60e3, sems: 120e3, fc: 30 * 60e3, radar: 10 * 60e3, net: 5 * 60e3, warn: 3 * 60e3, climate: 60e3, wxhist: 10 * 60e3, evhist: 15 * 60e3, beach: 30 * 60e3, cal: 5 * 60e3 };
  // How old before a source is shown amber. Pi or cloud hiccups shouldn't look like outages.
  const STALE = { ev: 3 * 60e3, wx: 10 * 60e3, sems: 10 * 60e3, fc: 3 * 3600e3, radar: 30 * 60e3, net: 20 * 60e3, warn: 15 * 60e3, climate: 5 * 60e3, wxhist: 40 * 60e3, evhist: 60 * 60e3, beach: 6 * 3600e3, cal: 30 * 60e3 };
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'light') document.documentElement.dataset.theme = 'light';

  const $ = id => document.getElementById(id);
  const S = { ev: null, sems: null, wx: null, fc: null, radar: null, net: null, warn: null, climate: null, wxhist: null, evhist: null, beach: null, cal: null };   // latest payloads
  const at = {}, failed = {};                                             // last success time, failure flags

  // ---------- time helpers (always Melbourne, whatever the device thinks) ----------
  const fmtParts = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function mel(d = new Date()) {
    const p = Object.fromEntries(fmtParts.formatToParts(d).map(x => [x.type, x.value]));
    const h = +p.hour, m = +p.minute;
    return { key: `${p.year}-${p.month}-${p.day}`, h, m, hf: h + m / 60 };
  }
  const tomorrowKey = () => mel(new Date(Date.now() + 86400e3)).key;
  const clock = d => d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const ampm = h => h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`;
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  // Forecast times are local wall-clock strings like 2026-10-30T14:00
  const fcHour = t => +t.slice(11, 13);

  // ---------- number helpers ----------
  const has = v => typeof v === 'number' && Number.isFinite(v);
  const f1 = v => has(v) ? v.toFixed(1) : '--';
  const f0 = v => has(v) ? Math.round(v).toString() : '--';
  const kw = w => has(w) ? (w / 1000).toFixed(Math.abs(w) >= 10000 ? 0 : 1) : '--';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- fetch with status tracking ----------
  // Dashboard key for locked functions (calendar). Stored once per device; sent only to this site.
  const hubKey = () => { try { return localStorage.getItem('hubToken') || ''; } catch (e) { return ''; } };
  async function pull(name, url, timeout = 20000) {
    try {
      const own = url.startsWith('/'), key = own ? hubKey() : '';
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout), headers: key ? { 'x-hub-token': key } : {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      S[name] = j; at[name] = Date.now(); failed[name] = false;
    } catch (e) {
      failed[name] = true;
      console.warn(name, e.message);
    }
    renderDots();
    return S[name];
  }
  function renderDots() {
    for (const n of Object.keys(S)) {
      const el = $('dot-' + n), age = at[n] ? Date.now() - at[n] : Infinity;
      if (!el) continue;
      el.className = 'dot ' + (!at[n] ? (failed[n] ? 'err' : '') : age > STALE[n] ? (failed[n] ? 'err' : 'stale') : 'ok');
      el.title = at[n] ? `Updated ${ago(at[n])}` + (failed[n] ? ', last try failed' : '') : (failed[n] ? 'Not reachable' : 'Loading');
    }
  }

  // ---------- weather icons (same set as ev.html) ----------
  const SUN = (cx, cy, r) => `<g stroke="var(--solar)" stroke-width="2.4" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => { const t = a * Math.PI / 180; return `<line x1="${(cx + Math.cos(t) * (r + 4)).toFixed(1)}" y1="${(cy + Math.sin(t) * (r + 4)).toFixed(1)}" x2="${(cx + Math.cos(t) * (r + 8)).toFixed(1)}" y2="${(cy + Math.sin(t) * (r + 8)).toFixed(1)}"/>`; }).join('')}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--solar)"/>`;
  const MOON = (cx, cy, r) => `<path d="M${cx + r * 0.4} ${cy - r} a${r} ${r} 0 1 0 ${r * 0.6} ${r * 1.55} a${r * 0.8} ${r * 0.8} 0 0 1 ${-r * 0.6} ${-r * 1.55}z" fill="var(--text-muted)"/>`;
  const CLOUD = (dx, dy) => `<path transform="translate(${dx} ${dy})" d="M14 40h26a10 10 0 0 0 0-20 13 13 0 0 0-25-3A10 10 0 0 0 14 40z" fill="var(--surface-3)" stroke="var(--text-muted)" stroke-width="1.6" stroke-linejoin="round"/>`;
  const DROPS = n => [18, 28, 38].slice(0, n).map((x, i) => `<line x1="${x}" y1="${48 + (i % 2) * 2}" x2="${x - 3}" y2="${55 + (i % 2) * 2}" stroke="var(--rain)" stroke-width="2.4" stroke-linecap="round"/>`).join('');
  const ICONS = {
    sun: SUN(28, 28, 11), moon: MOON(26, 28, 11), partly: SUN(22, 20, 8) + CLOUD(4, 10), partlyNight: MOON(20, 18, 8) + CLOUD(4, 10),
    cloud: CLOUD(2, 4), showers: SUN(22, 18, 7) + CLOUD(4, 6) + DROPS(2), drizzle: CLOUD(2, 4) + DROPS(3), rain: CLOUD(2, 2) + DROPS(3),
    storm: CLOUD(2, 2) + '<path d="M30 42l-6 9h6l-4 9 10-12h-6l4-6z" fill="var(--solar)"/>' + DROPS(1),
  };
  const icon = k => `<svg viewBox="0 0 56 62" aria-hidden="true">${ICONS[k] || ICONS.cloud}</svg>`;
  // Hourly icon from WMO weather code, cloud cover and rain chance
  function hourKind(h, night) {
    const c = h.weatherCode;
    if (c >= 95) return 'storm';
    if ((c >= 61 && c < 95) || h.precipitation >= 1) return 'rain';
    if ((c >= 51 && c <= 57) || h.precipitation > 0) return h.cloudCover < 60 && !night ? 'showers' : 'drizzle';
    if (h.cloudCover < 30) return night ? 'moon' : 'sun';
    if (h.cloudCover < 70) return night ? 'partlyNight' : 'partly';
    return 'cloud';
  }
  // Day verdicts match ev.html exactly (same kind rules, same labels, same 1-10 solar score), so the
  // overview and the EV page never disagree about a day
  const KIND_TXT = { storm: 'Thunderstorms', rain: 'Rain', showers: 'Sun and showers', drizzle: 'Cloudy, drizzle', fog: 'Fog, then sun', sun: 'Sunny', partly: 'Partly cloudy', cloud: 'Cloudy' };
  const dayIcon = k => icon(k === 'fog' ? 'partly' : k);
  function dayKind(d) {
    if (d.code >= 95) return 'storm';
    if (d.rain >= 3 || (d.code >= 61 && d.code < 95)) return 'rain';
    if (d.rain > 0 || (d.code >= 51 && d.code <= 57)) return d.cloud < 60 ? 'showers' : 'drizzle';
    if (d.code === 45 || d.code === 48) return 'fog';
    if (d.cloud < 30) return 'sun';
    if (d.cloud < 70) return 'partly';
    return 'cloud';
  }

  // ---------- derived forecast data ----------
  function fcDays() {
    const fc = S.fc; if (!fc) return [];
    const byDay = {}; (fc.hourly || []).forEach(h => (byDay[h.time.slice(0, 10)] ||= []).push(h));
    return (fc.daily || []).map(dl => {
      const hs = byDay[dl.date] || [], day = hs.filter(h => h.ghi > 50);
      const ghi = hs.reduce((a, h) => a + h.ghi, 0) / 1000;
      return {
        date: dl.date, code: dl.weatherCode || 0, rain: dl.precipitationSum || 0,
        rainProb: dl.precipProbabilityMax ?? Math.max(0, ...hs.map(h => h.precipProbability || 0)),
        tmax: dl.tempMax ?? (hs.length ? Math.max(...hs.map(h => h.temperature)) : null),
        tmin: dl.tempMin ?? (hs.length ? Math.min(...hs.map(h => h.temperature)) : null),
        cloud: Math.round(day.reduce((a, h) => a + h.cloudCover, 0) / Math.max(1, day.length)),
        kwh: Math.round(ghi * PANEL_KW * PR), ghi, sunrise: dl.sunrise, sunset: dl.sunset, uv: dl.uvIndexMax,
      };
    });
  }
  const solarScore = d => Math.max(1, Math.min(10, Math.round(10 * Math.min(1, d.ghi / 7.8) * (1 - 0.3 * d.cloud / 100) - (d.code >= 95 ? 1 : 0))));
  const scoreColor = s => s >= 8 ? 'var(--ok)' : s >= 5 ? 'var(--solar)' : 'var(--import)';
  // Solar still to come today (kWh), scaled so the hours add up to the same daily total that the
  // forecast rows and the EV page show (their daily estimate uses a slightly different factor)
  function solarLeftToday() {
    const hrs = todayHourly(), d = fcDays().find(x => x.date === mel().key); if (!hrs.length || !d) return 0;
    const all = hrs.reduce((a, h) => a + fcKw(h.ghi), 0) || 1, k = d.kwh / all, nh = mel().hf;
    return hrs.reduce((a, h) => { const hh = fcHour(h.time); return a + (hh + 1 <= nh ? 0 : fcKw(h.ghi) * k * (hh < nh ? hh + 1 - nh : 1)); }, 0);
  }
  function todayHourly() { const k = mel().key; return (S.fc?.hourly || []).filter(h => h.time.startsWith(k)); }
  function nextHours(n) {
    const now = mel(), k = now.key, all = S.fc?.hourly || [];
    const i = all.findIndex(h => h.time.slice(0, 10) === k && fcHour(h.time) === now.h);
    return i < 0 ? [] : all.slice(i, i + n);
  }
  function isNight(t) {
    const d = (S.fc?.daily || []).find(x => x.date === t.slice(0, 10));
    if (!d?.sunrise || !d?.sunset) { const h = fcHour(t); return h < 6 || h >= 20; }
    return t < d.sunrise.slice(0, 13) || t > d.sunset.slice(0, 13);
  }

  // ---------- live energy, merged from the Pi (fresh) and SEMS (lagged) ----------
  function energyNow() {
    const L = S.ev?.latest || null, c = L?.charger || {}, s = S.sems;
    const evAge = at.ev ? Date.now() - at.ev : Infinity;
    // Inverter over Modbus is real time; SEMS lags a few minutes. Prefer the Pi reading when fresh.
    let pv = null, pvSrc = '';
    if (L && has(L.pv_live_w) && evAge < STALE.ev) { pv = L.pv_live_w; pvSrc = 'inverter'; }
    else if (s && has(s.pvPower)) { pv = s.pvPower; pvSrc = 'SEMS'; }
    const car = has(c.power_w) ? c.power_w : 0;
    const home = s && has(s.homePower) ? s.homePower : (L && has(L.home_kw) ? L.home_kw * 1000 : null);   // includes the car
    const house = home != null ? Math.max(0, home - car) : null;
    const grid = s && has(s.gridPower) ? s.gridPower : null;                                              // + export, - import
    return { pv, pvSrc, car, house, home, grid, L, c, mode: S.ev?.mode, totals: S.ev?.totals || {} };
  }

  // ---------- render: header ----------
  function renderClock() {
    if (!$('clock')) return;
    const now = new Date();
    $('clock').textContent = clock(now);
    $('date').textContent = now.toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
    const d = fcDays().find(x => x.date === mel().key);
    if (d?.sunrise) {
      const t = s => { const h = +s.slice(11, 13), m = s.slice(14, 16); return `${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}`; };
      $('sun').textContent = `Sunrise ${t(d.sunrise)} · Sunset ${t(d.sunset)}`;
    }
  }

  // ---------- render: weather tile ----------
  // Set this when the detailed weather page exists; the tile title becomes a link.
  const WX_DETAIL_URL = 'weather.html';
  const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const cardinal = deg => has(deg) ? CARD[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : '';
  const uvLabel = u => !has(u) ? '' : u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme';
  // Small arrow pointing where the wind is blowing to; the text says where it comes from (BoM convention)
  const windArrow = deg => has(deg) ? `<svg class="warrow" viewBox="-8 -8 16 16" aria-hidden="true"><path transform="rotate(${deg + 180})" d="M0-7l5 10-5-3-5 3z" fill="var(--home)"/></svg>` : '';
  const WIND_ALERT = 50;   // km/h: wind or gusts above this go red
  const UV_ALERT = 6;      // UV at or above this goes red
  function next12Range() {
    const hs = nextHours(13).slice(1);
    if (!hs.length) return null;
    const hi = hs.reduce((a, h) => h.temperature > a.temperature ? h : a), lo = hs.reduce((a, h) => h.temperature < a.temperature ? h : a);
    return { hi: hi.temperature, hiAt: ampm(fcHour(hi.time)), lo: lo.temperature, loAt: ampm(fcHour(lo.time)) };
  }
  function maxGust12() {
    let best = { v: S.wx?.windGust || 0, at: 'now' };
    nextHours(12).forEach(h => { if ((h.windGust || 0) > best.v) best = { v: h.windGust, at: ampm(fcHour(h.time)) }; });
    return best;
  }
  // Today in a few words with an icon: the day's forecast, refined by what's left of it
  function todayOutlook() {
    const d = fcDays().find(x => x.date === mel().key); if (!d) return null;
    const rest = todayHourly().filter(h => fcHour(h.time) >= mel().h), w = S.wx;
    const pmax = Math.max(0, ...rest.map(h => h.precipProbability || 0)), storm = rest.some(h => h.weatherCode >= 95);
    const wetLeft = rest.reduce((a, h) => a + (h.precipitation || 0), 0), raining = w && has(w.rainRate) && w.rainRate > 0;
    let k = dayKind(d), text = KIND_TXT[k];
    if (storm) { k = 'storm'; text = 'Storms possible'; }
    else if (raining) { k = 'rain'; text = 'Raining now'; }
    else if (rest.length && wetLeft < 0.3 && pmax < 25 && (k === 'rain' || k === 'drizzle' || k === 'showers')) { k = d.cloud < 60 ? 'partly' : 'cloud'; text = 'Clearing, mostly dry now'; }
    else if (k !== 'rain' && pmax >= 25 && pmax < 55) { k = d.cloud < 60 ? 'showers' : 'drizzle'; text = 'Possible shower'; }
    else if (k !== 'rain' && pmax >= 55) { k = 'showers'; text = 'Showers likely'; }
    const gust = maxGust12().v;
    return { k, text: text + (gust > WIND_ALERT ? ', windy' : ''), tmax: d.tmax, tmin: d.tmin, pmax: Math.max(pmax, d.rainProb || 0), rain: d.rain };
  }
  const ADVICE_CLS = { Good: 'good', Fair: 'fair', Poor: 'poor' };
  function beachLine() {
    const b = S.beach?.sites; if (!b || !b.length) return '';
    return `<div class="beachline" title="EPA Victoria beach water quality forecast"><span>Beach water</span>${b.slice(0, 2).map(x => `<span class="bq ${ADVICE_CLS[x.advice] || ''}"><i></i>${esc(x.name.replace(/ Beach$| Life Saving Club$/, ''))} <b>${esc(x.advice || 'n/a')}</b></span>`).join('')}</div>`;
  }
  function renderWx() {
    const w = S.wx, box = $('wx-body');
    if (!box) return;
    if (WX_DETAIL_URL && $('wx-title')) $('wx-title').href = WX_DETAIL_URL;
    if (!w) { if (failed.wx) box.innerHTML = '<div class="empty">Weather station not reachable right now.</div>'; return; }
    const raining = has(w.rainRate) && w.rainRate > 0, r12 = next12Range();
    const row = (k, v, s = '', alert = false) => `<div class="wrow${alert ? ' alert' : ''}"><span class="k">${k}</span><span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    const windy = (w.windSpeed || 0) > WIND_ALERT || (w.windGust || 0) > WIND_ALERT;
    const o = todayOutlook();
    box.innerHTML = `
      ${o ? `<div class="today-wx">${dayIcon(o.k)}<div><b>${esc(o.text)}</b><span>Today ${f0(o.tmax)}° / ${f0(o.tmin)}°${o.pmax >= 20 ? ` · rain ${f0(o.pmax)}%` : ''}${o.rain >= 0.2 ? ` · ${f1(o.rain)} mm` : ''}</span></div></div>` : ''}${beachLine()}
      <div class="temps">
        <div><div class="label">Outside</div><div class="temp">${f1(w.temperature)}<sup>°</sup></div></div>
        <div><div class="label">Inside</div><div class="temp">${f1(w.indoorTemp)}<sup>°</sup></div></div>
      </div>
      <div class="wgrid">
        ${row('Feels like', `${f1(w.feelsLike)}°`)}
        ${row('Humidity', `${f0(w.humidity)}%`)}
        ${row('Wind', `${windArrow(w.windDirection)}${f0(w.windSpeed)}<small> km/h</small>`, [cardinal(w.windDirection), has(w.windGust) ? `gust ${f0(w.windGust)}` : ''].filter(Boolean).join(' · '), windy)}
        ${row('Rain today', `<span class="${raining ? 'raining' : ''}">${f1(w.rainDaily ?? 0)}</span><small> mm</small>`, raining ? `<span class="raining">${f1(w.rainRate)} mm/h now</span>` : (has(w.rainWeekly) ? `${f1(w.rainWeekly)} this week` : ''))}
        ${row('UV', has(w.uvi) ? f1(w.uvi) : '--', uvLabel(w.uvi), has(w.uvi) && w.uvi >= UV_ALERT)}
        ${row('Next 12 h', r12 ? `<span class="hi">${f0(r12.hi)}°</span><small> / </small><span class="lo">${f0(r12.lo)}°</span>` : '--', r12 ? `${r12.hiAt} · ${r12.loAt}` : '')}
      </div>
      <div class="wx-hours">${nextHours(7).slice(1).map(h => `<div><span>${ampm(fcHour(h.time)).replace(' ', '')}</span>${icon(hourKind(h, isNight(h.time)))}<b>${Math.round(h.temperature)}°</b><em>${h.precipProbability >= 20 ? h.precipProbability + '%' : ''}</em></div>`).join('')}</div>`;
    const t = w.stationTime ? new Date(w.stationTime) : (at.wx ? new Date(at.wx) : null);
    $('wx-meta').textContent = t ? `WS90 · ${clock(t)}` : 'Ecowitt WS90';
  }

  // ---------- energy accounting ----------
  // Solar serves the house first; the controller only gives the car what's spare, then the rest is exported.
  function allocate(pv, house, car) {
    pv = Math.max(0, pv || 0); house = Math.max(0, house || 0); car = Math.max(0, car || 0);
    const sHouse = Math.min(pv, house), sCar = Math.min(pv - sHouse, car), exp = pv - sHouse - sCar;
    return { sHouse, sCar, exp, gHouse: house - sHouse, gCar: car - sCar };
  }
  // Excess solar: export of at least one minimum charge (6 A, about 1.4 kW) with no car charging,
  // sustained for 30 minutes. Uses the controller's 5-minute series so a page reload doesn't reset it.
  const EXCESS_W = 1400, EXCESS_MIN = 30;
  function excessSolar() {
    const e = energyNow();
    const liveSpare = has(e.pv) && e.house != null ? e.pv - e.house - e.car : null;
    if (liveSpare == null || liveSpare < EXCESS_W || e.car > 200) return null;
    const ser = S.ev?.series || [];
    let mins = 0, sum = 0;
    for (let i = ser.length - 1; i >= 0; i--) {
      const b = ser[i], spare = b.pv - b.home;            // home includes the car
      if (spare >= EXCESS_W && b.car < 200) { mins += 5; sum += spare; } else break;
    }
    return mins >= EXCESS_MIN ? { mins, kw: liveSpare / 1000, avg: sum / (mins / 5) / 1000 } : null;
  }
  // Today's totals from the 5-minute series (kWh)
  function todayTotals() {
    const ser = S.ev?.series || [];
    if (!ser.length) return null;
    const T = { solarUsed: 0, gridOff: 0, gridPeak: 0, house: 0, car: 0, exp: 0, pv: 0 };
    const hrs = 5 / 60, nowH = mel().hf;
    ser.forEach((b, i) => {
      const h = +b.t.slice(0, 2) + +b.t.slice(3, 5) / 60;
      const dt = i === ser.length - 1 ? Math.max(0, Math.min(hrs, nowH - h)) : hrs;   // last bucket is still filling
      const pv = b.pv / 1000, car = b.car / 1000, house = Math.max(0, b.home - b.car) / 1000;
      const a = allocate(pv, house, car), grid = a.gHouse + a.gCar;
      T.pv += pv * dt; T.solarUsed += (a.sHouse + a.sCar) * dt; T.exp += a.exp * dt;
      T.house += house * dt; T.car += car * dt;
      if (h < 6) T.gridOff += grid * dt; else T.gridPeak += grid * dt;
    });
    return T;
  }

  // ---------- render: energy flow diagram ----------
  const ICON = {
    sun: '<circle r="7" fill="var(--solar)"/>' + [0, 45, 90, 135, 180, 225, 270, 315].map(a => { const t = a * Math.PI / 180; return `<line x1="${(Math.cos(t) * 10).toFixed(1)}" y1="${(Math.sin(t) * 10).toFixed(1)}" x2="${(Math.cos(t) * 14).toFixed(1)}" y2="${(Math.sin(t) * 14).toFixed(1)}" stroke="var(--solar)" stroke-width="2.2" stroke-linecap="round"/>`; }).join(''),
    grid: '<path d="M-6 14L0-13L6 14M-9-6h18M-11 2h22M-3 6l6-6M3 6l-6-6" fill="none" stroke="var(--text)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
    house: '<path d="M-12 1L0-11L12 1M-8-2v13h16V-2" fill="none" stroke="var(--home)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/><rect x="-2.5" y="4" width="5" height="7" fill="var(--home)"/>',
    car: '<path d="M-16 4.5v-4c0-1.6 1-2.6 2.6-3.1l3.4-.9 3.8-4.6c.8-1 1.9-1.5 3.1-1.5h5.6c1.3 0 2.5.6 3.3 1.7L9.3-3.5l4.2 1.2c1.5.4 2.5 1.6 2.5 3.1v3.7z" fill="none" stroke="var(--car)" stroke-width="2" stroke-linejoin="round"/><path d="M-7.2-4.1l2.9-3.6c.4-.5.9-.7 1.5-.7h2.1v4.3zM1.3-8.4h2.4c.6 0 1.2.3 1.6.8l2.7 3.5H1.3z" fill="var(--car)" opacity=".55"/><circle cx="-8.5" cy="5" r="3.6" fill="var(--surface-2)" stroke="var(--car)" stroke-width="2"/><circle cx="8.5" cy="5" r="3.6" fill="var(--surface-2)" stroke="var(--car)" stroke-width="2"/>',
  };
  const STATE_TXT = { charging: 'Charging', ready: 'Plugged in', complete: 'Session finished', full: 'Car full',
    not_connected: 'Not plugged in', wait_button: 'Waiting for button', wait_swipe: 'Waiting for card', reserved: 'Scheduled', fault: 'Charger fault' };
  function renderFlow() {
    const box = $('flow-body');
    if (!box) return;
    if (!S.ev && !S.sems) { if (failed.ev && failed.sems) box.innerHTML = '<div class="empty">Solar and charger data unavailable right now.</div>'; return; }
    const e = energyNow(), L = e.L || {}, c = e.c;
    const pv = has(e.pv) ? e.pv : 0, house = e.house ?? 0, car = e.car || 0;
    const a = allocate(pv, house, car);
    // Grid direction: trust the live balance when we have the inverter reading, else SEMS
    const net = has(e.pv) && e.house != null ? pv - house - car : (has(e.grid) ? e.grid : 0);
    const imp = Math.max(0, -net), exp = Math.max(0, net);
    const pct = v => pv > 100 ? Math.round(v / pv * 100) + '%' : '';
    const W = 360, H = 252, hub = [180, 124];
    const N = { solar: [180, 34], grid: [44, 124], house: [316, 124], car: [180, 214] };
    const width = p => (2 + 5 * Math.min(1, p / 7000)).toFixed(1);
    // Each live wire gets an arrowhead part-way along it, pointing the way the power is flowing
    const arrow = (a, b, p, col) => {
      const t = 0.58, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI, k = 6 + 4 * Math.min(1, p / 7000);
      return `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${ang.toFixed(1)})" d="M${k} 0L${-k * 0.8} ${-k * 0.85}L${-k * 0.35} 0L${-k * 0.8} ${k * 0.85}Z" fill="${col}" stroke="var(--surface)" stroke-width="1.5" stroke-linejoin="round"/>`;
    };
    const wire = (from, to, p, col, rev) => {
      const d = `M${from[0]},${from[1]} L${to[0]},${to[1]}`;
      if (p < 50) return `<path class="wire bg" d="${d}" stroke-width="6"/>`;
      return `<path class="wire bg" d="${d}" stroke-width="6"/><path class="wire live${rev ? ' rev' : ''}" d="${d}" stroke="${col}" stroke-width="${width(p)}"/>` + (rev ? arrow(to, from, p, col) : arrow(from, to, p, col));
    };
    const node = (k, pos, col, active) => `<g transform="translate(${pos[0]} ${pos[1]})"> <circle r="27" fill="var(--surface-2)" stroke="${active ? col : 'var(--border-strong)'}" stroke-width="2"/><g>${ICON[k]}</g></g>`;
    const txt = (x, y, anchor, big, small, col = 'var(--text)') => `<text x="${x}" y="${y}" text-anchor="${anchor}"><tspan class="num" font-size="21" fill="${col}">${big}</tspan><tspan x="${x}" dy="17" font-size="13" fill="var(--text-muted)">${esc(small)}</tspan></text>`;
    const gridCol = imp >= 50 ? 'var(--import)' : 'var(--gridout)';
    const carState = !S.ev ? 'Pi not reachable' : c.state === 'charging' ? (L.override ? 'Manual, full rate' : L.window === 'offpeak' ? 'Off-peak charge' : 'Matching solar') : (STATE_TXT[c.state] || 'Not plugged in');
    let s = '';
    s += wire(N.solar, hub, pv, 'var(--solar)', false);
    s += wire(hub, N.house, house, 'var(--home)', false);
    s += wire(hub, N.car, car, 'var(--car)', false);
    s += wire(N.grid, hub, Math.max(imp, exp), gridCol, exp >= 50);   // reverse = exporting
    s += `<circle cx="${hub[0]}" cy="${hub[1]}" r="5" fill="var(--text-muted)"/>`;
    s += node('sun', N.solar, 'var(--solar)', pv >= 50) + node('grid', N.grid, gridCol, imp >= 50 || exp >= 50) + node('house', N.house, 'var(--home)', house >= 50) + node('car', N.car, 'var(--car)', car >= 50);
    s += txt(216, 32, 'start', `${kw(pv)} kW`, `Solar${e.pvSrc ? ' · ' + e.pvSrc : ''}`, 'var(--solar)');
    s += txt(44, 172, 'middle', `${kw(imp >= 50 ? imp : exp)} kW`, imp >= 50 ? 'Importing' : exp >= 50 ? 'Exporting' : 'Grid idle', imp >= 50 ? 'var(--import)' : 'var(--text)');
    s += txt(316, 172, 'middle', `${kw(house)} kW`, 'House');
    s += txt(216, 212, 'start', `${kw(car)} kW`, carState);
    // % of solar going each way, on the wires
    const badge = (x, y, v, col) => v ? `<text x="${x}" y="${y}" text-anchor="middle" font-size="14" font-weight="600" fill="${col}" class="num">${v}</text>` : '';
    if (pv > 100) {
      s += badge(248, 114, pct(a.sHouse), 'var(--home)') + badge(200, 174, pct(a.sCar), 'var(--car)') + badge(112, 112, pct(a.exp), 'var(--gridout)');
    }
    const solarLine = pv > 100
      ? `<div class="split"><div class="split-bar"><i style="width:${(a.sHouse / pv * 100).toFixed(1)}%;background:var(--home)"></i><i style="width:${(a.sCar / pv * 100).toFixed(1)}%;background:var(--car)"></i><i style="width:${(a.exp / pv * 100).toFixed(1)}%;background:var(--gridout)"></i></div>
         <div class="split-leg"><span style="--c:var(--home)">House <b>${pct(a.sHouse)}</b></span><span style="--c:var(--car)">Car <b>${pct(a.sCar)}</b></span><span style="--c:var(--gridout)">Grid <b>${pct(a.exp)}</b></span>${imp >= 50 ? `<span style="--c:var(--import)">Grid supplying <b>${Math.round(imp / Math.max(1, house + car) * 100)}%</b> of use</span>` : ''}</div></div>`
      : `<div class="split"><div class="split-leg">${mel().h >= 5 && mel().h < 21 ? 'Barely generating right now.' : 'No solar overnight.'}${L.window === 'offpeak' ? ' Off-peak window, 8c until 6 am.' : ''}</div></div>`;
    const ex = excessSolar();
    const exBox = ex ? `<div class="excess" role="alert"><svg viewBox="-16 -16 32 32" aria-hidden="true">${ICON.sun}</svg><div><b>Excess solar - Suggest Car Charging</b><span>About ${ex.kw.toFixed(1)} kW spare for ${ex.mins >= 60 ? Math.floor(ex.mins / 60) + ' h ' + (ex.mins % 60 ? (ex.mins % 60) + ' min' : '') : ex.mins + ' min'}, going to the grid at 0.5c</span></div></div>` : '';
    box.innerHTML = `<svg class="flow-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live energy flow between solar, grid, house and car">${s}</svg>${solarLine}${L.override ? '<span class="chip over">Manual override, full rate until unplugged</span>' : ''}${exBox}`;
    const modeTxt = { auto: 'Auto', full: 'Full rate', off: 'Off' }[e.mode] || null;
    const winTxt = { day: 'solar window', offpeak: 'off-peak', evening: 'evening' }[L.window] || '';
    if ($('en-mode')) $('en-mode').textContent = modeTxt ? `${modeTxt}${winTxt ? ' · ' + winTxt : ''} · ` : '';
  }

  // ---------- efficiency donuts (today), same maths and colours as the EV page ----------
  // Car: solar counts 100%, off-peak grid 72% (the share of on-peak cost it avoids next to solar:
  // (27.6c - 8c) / (27.6c - 0.5c)), on-peak grid 0. Solar: share of generation used at home.
  const effColor = e => e == null ? '#d8d9da' : e >= 85 ? '#73bf69' : e >= 60 ? '#fade2a' : e >= 30 ? '#ff9830' : '#f2495c';
  function miniPie(title, segs, total, eff, href) {
    const r = 54, C = 2 * Math.PI * r; let off = 0, arcs = '';
    if (total > 0) segs.forEach(([n, v, col]) => { if (v <= 0) return; const len = C * v / total;
      arcs += `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${col}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 75 75)"/>`; off += len; });
    else arcs = '<circle cx="75" cy="75" r="54" fill="none" stroke="var(--surface-3)" stroke-width="22"/>';
    const svg = `<svg viewBox="0 0 150 150" aria-hidden="true">${arcs}<text x="75" y="84" text-anchor="middle" fill="${effColor(eff)}" font-family="var(--sans)" font-size="34" font-weight="700">${eff == null ? '–' : eff + '%'}</text></svg>`;
    const leg = segs.map(([n, v, col]) => `<div><i style="background:${col}"></i><span>${n}</span><b>${v.toFixed(1)}</b></div>`).join('');
    return `<a class="eff" href="${href}" title="${esc(title)} efficiency today">${svg}<div class="eff-leg"><div class="eff-t">${title}<small>${total.toFixed(1)} kWh</small></div>${leg}</div></a>`;
  }
  function renderEff() {
    const box = $('eff'); if (!box) return;
    const T = S.ev?.totals;
    if (!T) { if (failed.ev) box.innerHTML = ''; return; }
    const credit = (RATE.general - RATE.offpeak) / (RATE.general - RATE.feedin);
    const solar = T.car_solar_kwh || 0, off = T.car_offpeak_kwh || 0, grid = T.car_grid_day_kwh || 0, car = solar + off + grid;
    const house = T.house_solar_kwh || 0, exp = T.export_kwh || 0, gen = Math.max(T.solar_kwh || 0, solar + house + exp);
    box.innerHTML =
      miniPie('Car charging', [['Solar', solar, '#fade2a'], ['Off-peak', off, '#e89cbd'], ['On-peak', grid, '#f2495c']], car, car > 0.05 ? Math.round(100 * (solar + off * credit) / car) : null, 'ev.html') +
      miniPie('Solar', [['Cars', solar, '#73bf69'], ['House', house, '#5794f2'], ['Exported', exp, 'rgba(204,204,220,.42)']], gen, gen > 0.05 ? Math.round(100 * (solar + house) / gen) : null, 'energy.html');
  }

  // ---------- render: today's mix donuts ----------
  const RATE = { general: 0.27621, offpeak: 0.08, feedin: 0.005 };
  function donut(parts, centreBig, centreSmall) {
    const total = parts.reduce((s, p) => s + p.v, 0);
    const R = 42, C = 2 * Math.PI * R;
    let off = 0, arcs = '';
    if (total > 0.01) parts.forEach(p => { const len = p.v / total * C; if (len > 0.3) arcs += `<circle r="${R}" fill="none" stroke="${p.c}" stroke-width="16" stroke-dasharray="${(len - 1).toFixed(2)} ${(C - len + 1).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90)"/>`; off += len; });
    return `<svg viewBox="-60 -60 120 120" aria-hidden="true"><circle r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="16"/>${arcs}
      <text y="2" text-anchor="middle" font-size="17" font-family="var(--mono)" fill="var(--text)">${centreBig}</text><text y="17" text-anchor="middle" font-size="8.5" fill="var(--text-muted)" font-family="var(--sans)">${centreSmall}</text></svg>`;
  }
  const legend = parts => { const t = parts.reduce((s, p) => s + p.v, 0) || 1; return `<div class="pie-leg">${parts.map(p => `<div><i style="--c:${p.c}"></i><span>${p.n}</span><b>${p.v.toFixed(1)}<small>${Math.round(p.v / t * 100)}%</small></b>${p.sub ? `<span class="sub">${p.sub}</span>` : ''}</div>`).join('')}</div>`; };
  function renderPies() {
    if (!$('pies')) return;
    const T = todayTotals();
    if (!T) { if (failed.ev) $('pies').innerHTML = '<div class="empty">Needs the Pi for today\'s totals.</div>'; return; }
    const used = T.solarUsed + T.gridOff + T.gridPeak, went = T.house + T.car + T.exp;
    const src = [
      { n: 'Solar', v: T.solarUsed, c: 'var(--solar)', sub: 'free, made on the roof' },
      { n: 'Grid off-peak', v: T.gridOff, c: 'var(--import-soft)', sub: `$${(T.gridOff * RATE.offpeak).toFixed(2)} at 8c` },
      { n: 'Grid peak', v: T.gridPeak, c: 'var(--import)', sub: `$${(T.gridPeak * RATE.general).toFixed(2)} at 27.6c` },
    ];
    const dst = [
      { n: 'House', v: T.house, c: 'var(--home)' },
      { n: 'Car charging', v: T.car, c: 'var(--car)' },
      { n: 'Exported to grid', v: T.exp, c: 'var(--gridout)', sub: `$${(T.exp * RATE.feedin).toFixed(2)} at 0.5c` },
    ];
    $('pies').innerHTML = `
      <div class="pie"><h3>Where it came from</h3>${donut(src, used.toFixed(1), 'kWh used')}${legend(src)}</div>
      <div class="pie"><h3>Where it went</h3>${donut(dst, went.toFixed(1), 'kWh total')}${legend(dst)}</div>`;
    if ($('mix-meta')) $('mix-meta').textContent = `since midnight · solar made ${T.pv.toFixed(1)} kWh`;
  }

  // ---------- render: car charging tile (same logic as ev.html) ----------
  // Usable battery sizes match ev.html. The EV5's % comes from Kia Connect via the Pi; the IONIQ 5
  // has no live reading, so while it's on the charger we show the % added since it was plugged in.
  const CARS = { ev5: { name: 'Kia EV5', kwh: 88 }, ioniq5: { name: 'IONIQ 5', kwh: 72.6 } };
  const plugState = c => c && (c.plug === 'plugged' || c.plug === 'plugged_locked');
  function carOnCharger() {
    const d = S.ev || {}, info = d.car || null, c = d.latest?.charger || {};
    if (!plugState(c)) return null;
    if (info && CARS[info.car]) return info.car;
    const k5 = info && info.ev5;
    if (k5 && (k5.plugged === false || k5.at_home === false)) return 'ioniq5';
    return null;
  }
  function chargeSource() {
    const L = S.ev?.latest || {}, c = L.charger || {}, watts = c.power_w || 0, plug = S.ev?.plugin;
    if (!plugState(c)) return null;
    if (c.state === 'complete' || c.state === 'full' || (c.state === 'charging' && watts <= 200 && plug && plug.kwh > 0.5)) return { cls: 'full', text: 'Plugged in, charged' };
    if (!(c.state === 'charging' && watts > 200)) return { cls: 'wait', text: 'Plugged in, waiting' };
    if (L.override) return { cls: 'grid', text: 'Manual, full rate' };
    if (L.window === 'offpeak') return { cls: 'off', text: 'Charging, off-peak grid' };
    const pv = L.pv_live_w != null ? L.pv_live_w : (L.pv_kw != null ? L.pv_kw * 1000 : 0);
    const houseW = L.house_w != null ? L.house_w : (L.home_kw != null ? Math.max(0, L.home_kw * 1000 - watts) : 0);
    return Math.min(watts, Math.max(0, pv - houseW)) >= watts * 0.5 ? { cls: 'sun', text: 'Charging from solar' } : { cls: 'grid', text: 'Charging, peak grid' };
  }
  // The Pi's clock offset (e.g. +1100), so times in its log can be read correctly
  const piOffset = () => { const m = String(S.ev?.server_time || '').match(/([+-]\d{2})(\d{2})$/); return m ? `${m[1]}:${m[2]}` : '+11:00'; };
  const piTime = ts => new Date(/[+-]\d{2}:?\d{2}$|Z$/.test(ts) ? ts : ts + piOffset());
  // When the current charge started: the start of the latest run of 5-minute buckets above 200 W.
  // If the run goes back to midnight, the plug-in time is the better answer.
  function chargingSince() {
    const ser = S.ev?.series || [];
    let i = ser.length - 1;
    if (i < 0 || !(ser[i].car > 200)) return null;
    while (i > 0 && ser[i - 1].car > 200) i--;
    let t = piTime(`${mel().key}T${ser[i].t}:00`);
    const p = S.ev?.plugin;
    if (i === 0 && p?.since) { const ps = piTime(p.since); if (ps < t) t = ps; }
    return t;
  }
  const hm = mins => { mins = Math.max(0, Math.round(mins)); return mins >= 60 ? `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min` : `${mins} min`; };
  const tShort = d => d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  function renderCars() {
    const box = $('cars');
    if (!box) return;
    if (!S.ev) { if (failed.ev) box.innerHTML = '<div class="empty">Needs the Pi for charger data.</div>'; return; }
    const d = S.ev, c = d.latest?.charger || {}, T = d.totals || {}, on = carOnCharger(), src = chargeSource();
    const k5 = d.car?.ev5 || null, charging = c.state === 'charging' && (c.power_w || 0) > 200;
    const since = charging ? chargingSince() : null;
    box.innerHTML = Object.entries(CARS).map(([id, car]) => {
      const isOn = on === id;
      let soc = null, est = null, socNote = '';
      if (id === 'ev5' && k5 && k5.soc != null) { soc = k5.soc; socNote = k5.limit_ac ? `to ${k5.limit_ac}%` : ''; }
      else if (id === 'ioniq5' && isOn && d.plugin) { est = Math.min(100, 100 * d.plugin.kwh / car.kwh); socNote = 'added since plugged in'; }
      let chip = '<span class="cchip">Not on the charger</span>';
      if (isOn && src) chip = `<span class="cchip ${src.cls}">${src.text}</span>`;
      else if (id === 'ev5' && k5 && k5.at_home === false) chip = `<span class="cchip">${k5.plugged ? 'Plugged in away' : 'Away from home'}</span>`;
      const pct = soc != null ? soc : est;
      const col = soc == null ? 'var(--car)' : soc < 20 ? 'var(--import)' : soc < 50 ? 'var(--solar)' : 'var(--car)';
      const pctTxt = soc != null ? `${Math.round(soc)}%` : est != null ? `+${Math.round(est)}%` : '--';
      const live = isOn && charging
        ? `<div class="clive"><b>${kw(c.power_w)} kW</b><span>${f0(c.amps)} A</span>${since ? `<span>since ${tShort(since)} · ${hm((Date.now() - since) / 60e3)}</span>` : ''}</div>`
        : '';
      const hrs = T[`car_${id}_hours`] || 0, kwh = T[`car_${id}_kwh`] || 0;
      const today = hrs >= 1 / 60 ? `Today ${hm(hrs * 60)} · ${kwh.toFixed(1)} kWh` : 'Not charged today';
      return `<div class="crow${isOn ? ' on' : ''}">
        <div class="ctop"><span class="cname">${car.name}</span>${chip}</div>
        <div class="cbatt"><div class="cbar"><i style="width:${pct != null ? Math.max(2, Math.min(100, pct)) : 0}%;background:${col}"></i></div><b class="cpct">${pctTxt}</b></div>
        ${live}
        <div class="cfoot">${socNote ? `<span>${socNote}</span>` : ''}<span>${today}</span></div>
      </div>`;
    }).join('');
    if (plugState(c) && !on) box.insertAdjacentHTML('beforeend', '<div class="cnote">A car is plugged in but the Pi hasn\'t identified which. Set it on the EV page.</div>');
  }

  // ---------- render: internet (UniFi) ----------
  function renderNet() {
    const n = S.net, el = $('net');
    if (!el) return;
    if (!n) { el.hidden = true; return; }          // not set up yet or unreachable: the NET dot shows which
    el.hidden = false;
    const bad = !n.online || n.issues > 0 || (n.packetLoss || 0) >= 2 || (n.latencyMs || 0) >= 80;
    el.className = 'net' + (!n.online ? ' down' : bad ? ' warn' : '');
    const devs = (n.clients?.wifi || 0) + (n.clients?.wired || 0);
    el.innerHTML = `<i></i><span>${n.online ? 'Online' : 'Offline'}</span>${has(n.latencyMs) ? `<b>${Math.round(n.latencyMs)} ms</b>` : ''}${has(n.downMbps) ? `<b>↓${Math.round(n.downMbps)} ↑${Math.round(n.upMbps)}</b>` : ''}<span>${devs} devices</span>`;
    el.title = `${n.isp || 'Internet'} via ${n.gateway || 'UniFi'} · uptime ${f0(n.wanUptime)}% · packet loss ${f1(n.packetLoss)}%${n.metricTime ? ' · measured ' + clock(new Date(n.metricTime)) : ''}`;
  }

  // ---------- render: forecast ----------
  function renderForecast() {
    if (!$('days')) return;
    const days = fcDays(), hrs = nextHours(+($('hours')?.dataset.hours || 8));
    if (!days.length) { if (failed.fc) $('days').innerHTML = '<div class="empty">Forecast unavailable right now.</div>'; return; }
    if ($('hours')) $('hours').innerHTML = hrs.map((h, i) => {
      const hr = fcHour(h.time);
      return `<div class="hr${i === 0 ? ' now' : ''}"><span>${i === 0 ? 'Now' : ampm(hr)}</span>${icon(hourKind(h, isNight(h.time)))}<b>${Math.round(h.temperature)}°</b><span class="p">${h.precipProbability >= 10 ? h.precipProbability + '%' : ''}</span></div>`;
    }).join('');
    const today = mel().key, tmw = tomorrowKey();
    $('days').innerHTML = days.slice(0, +($('days').dataset.days || 6)).map(d => {
      const name = d.date === today ? 'Today' : d.date === tmw ? 'Tmrw' : new Date(d.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short' });
      const sc = solarScore(d);
      const rain = d.rain >= 0.2 ? `${f1(d.rain)} mm` : d.rainProb >= 20 ? `${f0(d.rainProb)}%` : '';
      const k = dayKind(d);
      return `<div class="day" title="${KIND_TXT[k]} · solar ${sc}/10 · about ${d.kwh} kWh"><span class="n">${name}</span>${dayIcon(k)}<span class="r">${rain}</span><span class="t">${f0(d.tmax)}° <span>${f0(d.tmin)}°</span></span><span class="sc" style="--sc:${scoreColor(sc)}"><b>${sc}</b>/10</span><span class="k">${d.kwh}<small> kWh</small></span></div>`;
    }).join('');
    $('fc-meta').textContent = `Open-Meteo · ${S.fc.timestamp ? 'updated ' + clock(new Date(S.fc.timestamp)) : 'Dromana'}`;
  }

  // ---------- climate (iZone AC through the Pi bridge; read-only here) ----------
  // Zone numbers match the Climate Control page (climate.html CLIMATE_ROOMS).
  const ZONES = { 1: 'Lounge', 2: 'Master', 3: "Charlie's", 4: "Mila's", 5: 'Office', 6: 'Bathroom' };
  const AC_MODE = { 1: 'Cool', 2: 'Heat', 3: 'Fan', 4: 'Dry', 5: 'Auto', 6: 'Exhaust', 7: 'Pump' };
  const AC_FAN = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Auto', 5: 'Top' };
  const BRIDGE = p => `/.netlify/functions/bridge?p=${p}`;
  let zonesAt = 0;
  async function pullClimate() {
    const post = (p, body, ms) => fetch(BRIDGE(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
    try {
      const sys = await post('/api/izone/query', { iZoneV2Request: { Type: 1, No: 0, No1: 0 } }, 9000);
      if (!sys || !sys.SystemV2) throw new Error('no SystemV2');
      const prev = S.climate || {};
      S.climate = { ...prev, sys: sys.SystemV2 };
      // Zones are a heavier call (one request per zone on the iZone), so refresh them every 5 minutes
      if (Date.now() - zonesAt > 5 * 60e3) {
        zonesAt = Date.now();
        post('/api/izone/zones', {}, 15000).then(z => { S.climate.zones = z.zones || []; renderClimate(); }).catch(() => {});
        fetch(BRIDGE('/api/sensors/temps'), { signal: AbortSignal.timeout(9000) }).then(r => r.ok ? r.json() : null).then(t => { if (t) { S.climate.sensors = t.rooms || {}; renderClimate(); } }).catch(() => {});
      }
      at.climate = Date.now(); failed.climate = false;
    } catch (e) { failed.climate = true; console.warn('climate', e.message); }
    renderDots();
  }
  function climateSummary() {
    const c = S.climate; if (!c || !c.sys) return null;
    const sys = c.sys, on = sys.SysOn === 1;
    const open = (c.zones || []).filter(z => z.Mode === 1).map(z => ZONES[z.Index + 1] || `Zone ${z.Index + 1}`);
    const sensors = Object.entries(c.sensors || {}).filter(([, v]) => v && has(v.temp));
    const ret = has(sys.Temp) && sys.Temp > 0 ? sys.Temp / 100 : null, supply = has(sys.Supply) && sys.Supply > 0 ? sys.Supply / 100 : null;
    return { on, mode: AC_MODE[sys.SysMode] || '?', fan: AC_FAN[sys.SysFan] || '', setpoint: has(sys.Setpoint) ? sys.Setpoint / 100 : null,
      ret, supply, open, zonesKnown: Array.isArray(c.zones), sensors };
  }
  function renderClimate() {
    const box = $('climate'); if (!box) return;
    const c = climateSummary();
    if (!c) { if (failed.climate) box.innerHTML = '<div class="empty">Can\'t reach the AC through the Pi right now.</div>'; return; }
    const modeCls = { Cool: 'cool', Heat: 'heat' }[c.mode] || 'fan';
    const room = (n) => {
      const id = n.toLowerCase().replace(/[^a-z]/g, '').replace('charlies', 'charlie').replace('milas', 'mila').replace('bathroom', 'bath');
      const sv = c.sensors.find(([k]) => k === id);
      return sv ? ` ${f1(sv[1].temp)}°` : '';
    };
    box.innerHTML = `
      <div class="ac-top">
        <div class="ac-state ${c.on ? 'on ' + modeCls : 'off'}"><i></i><b>${c.on ? 'On' : 'Off'}</b>${c.on ? `<span>${c.mode}${c.fan ? ' · fan ' + c.fan.toLowerCase() : ''}</span>` : ''}</div>
        <div class="ac-set"><span class="label">Set to</span><b>${c.setpoint != null ? f1(c.setpoint) : '--'}<sup>°</sup></b></div>
      </div>
      ${c.ret != null || c.supply != null ? `<div class="ac-temps">${c.ret != null ? `<span>Return air <b>${f1(c.ret)}°</b></span>` : ''}${c.supply != null && c.on ? `<span>Supply <b>${f1(c.supply)}°</b></span>` : ''}</div>` : ''}
      <div class="ac-zones"><span class="label">${c.zonesKnown ? `Zones open · ${c.open.length} of ${Object.keys(ZONES).length}` : 'Zones loading…'}</span>
        <div class="zchips">${Object.values(ZONES).map(n => `<span class="zchip${c.open.includes(n) ? ' open' : ''}">${n}${room(n)}</span>`).join('')}</div></div>`;
  }

  // ---------- heads-up notes: the joined-up bit ----------
  // Header notes, most important first:
  //   official warnings (emergency / watch) > excess solar > calendar reminders > wind > UV > advice warnings > car > rain >
  //   solar outlook > nearby incidents (planned burns etc.) > Pi offline
  function warnNotes() {
    const list = S.warn?.items || [];
    const where = i => i.covers ? (i.location ? ` · ${i.location}` : '') : (i.distanceKm != null ? ` · ${i.distanceKm < 1 ? 'under 1' : Math.round(i.distanceKm)} km away` : '');
    return list.map(i => {
      const what = i.level === 'info' || i.level === 'advice' && !/warning|advice/i.test(i.title) ? `${(i.kind || '').split(' · ').pop() || 'Incident'}: ${i.title}` : i.title;
      const cls = i.level === 'emergency' ? 'alert emergency' : i.level === 'watch' ? 'alert' : i.level === 'advice' ? 'warn' : 'info';
      return { cls, text: (i.cap && i.level === 'advice' ? `${i.cap} advice` : what) + where(i), href: i.url, tip: i.headline, level: i.level };
    });
  }
  function carNote() {
    if (!S.ev) return null;
    const c = S.ev.latest?.charger || {};
    if (!plugState(c)) return { cls: 'info', text: 'No car plugged in' };
    const on = carOnCharger(), src = chargeSource(), k5 = S.ev.car?.ev5;
    const name = on ? CARS[on].name : 'A car (not identified)';
    const charging = c.state === 'charging' && (c.power_w || 0) > 200;
    const soc = on === 'ev5' && k5?.soc != null ? ` · ${Math.round(k5.soc)}%` : on === 'ioniq5' && S.ev.plugin ? ` · +${Math.round(100 * S.ev.plugin.kwh / CARS.ioniq5.kwh)}%` : '';
    return { cls: 'car', text: `${name} plugged in${charging ? ` · ${src ? src.text.toLowerCase() : 'charging'} ${kw(c.power_w)} kW` : src ? ` · ${src.text.replace(/^Plugged in, /, '')}` : ''}${soc}` };
  }
  function renderNotes() {
    if (!$('notes')) return;
    const out = [], w = S.wx, now = mel(), hrs = nextHours(12), e = energyNow(), warns = warnNotes();
    const add = (cls, text, extra = {}) => out.push({ cls, text, ...extra });
    warns.filter(x => x.level === 'emergency' || x.level === 'watch').forEach(x => out.push(x));
    const ex = excessSolar();
    if (ex) add('sun strong', `Excess solar - Suggest Car Charging (${ex.kw.toFixed(1)} kW spare)`);
    calNotes().forEach(x => out.push(x));
    // Wind: what the station sees now, or the strongest forecast gust in the next 12 hours
    const gust = maxGust12(), windNow = Math.max(w?.windSpeed || 0, w?.windGust || 0);
    if (windNow > WIND_ALERT) add('alert', `Strong wind now: ${Math.round(w.windSpeed || 0)} km/h, gusting ${Math.round(w.windGust || 0)}`);
    else if (gust.v > WIND_ALERT) add('alert', `Gusts up to ${Math.round(gust.v)} km/h in the next 12 hours${gust.at !== 'now' ? ` (around ${gust.at})` : ''}`);
    if (w && has(w.uvi) && w.uvi >= UV_ALERT) add('alert', `UV ${f1(w.uvi)}, ${uvLabel(w.uvi).toLowerCase()}. Sun protection needed`);
    warns.filter(x => x.level === 'advice').forEach(x => out.push(x));
    const cn = carNote(); if (cn) out.push(cn);
    // Raining now is shown in the weather tile itself, so only the heads-up for later goes here
    if (!(w && has(w.rainRate) && w.rainRate > 0)) { const wet = hrs.slice(1, 7).find(h => h.precipProbability >= 50); if (wet) add('rain', `Rain likely around ${ampm(fcHour(wet.time))} (${wet.precipProbability}%)`); }
    const fcLeft = solarLeftToday();
    const plugged = plugState(e.c);
    if (now.h >= 7 && now.h < 16 && S.ev && !plugged && fcLeft >= 8 && !ex) add('sun', `About ${Math.round(fcLeft)} kWh of sun left today. Plug a car in to use it.`);
    if (now.h >= 17) {
      const t = fcDays().find(d => d.date === tomorrowKey());
      // Same score and colours as the EV page: 8+ good, 5-7 fair, under 5 poor
      if (t) {
        const sc = solarScore(t), what = KIND_TXT[dayKind(t)].toLowerCase();
        if (sc >= 8) add('sun', `Tomorrow looks good for solar: ${sc}/10, ${what}, about ${t.kwh} kWh`);
        else if (sc >= 5) add('sun', `Tomorrow is fair for solar: ${sc}/10, ${what}, about ${t.kwh} kWh`);
        else add('warn', `Tomorrow is poor for solar: ${sc}/10, ${what}, about ${t.kwh} kWh. Overnight off-peak will do the heavy lifting.`);
      }
    }
    warns.filter(x => x.level === 'info').forEach(x => out.push(x));
    if ((S.ev && at.ev && Date.now() - at.ev > STALE.ev) || (!S.ev && failed.ev)) add('warn', "Can't reach the Pi. The charger controller keeps running on its own.");
    $('notes').innerHTML = out.slice(0, 5).map(n => n.href
      ? `<a class="note ${n.cls}" href="${esc(n.href)}"${n.local ? '' : ' target="_blank" rel="noopener"'} title="${esc(n.tip || '')}"><i></i>${esc(n.text)}</a>`
      : `<span class="note ${n.cls}"><i></i>${esc(n.text)}</span>`).join('');
  }

  // ---------- family calendar (Google, via the calendar function) ----------
  // Timed events carry an offset (2026-11-03T15:30:00+11:00); all-day events are a date, with an
  // exclusive end date. Everything is shown in Melbourne time.
  const calTime = d => d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(/\s?([ap])\.?m\.?/i, ' $1m');
  const evStart = e => e.allDay ? new Date(e.start + 'T00:00:00') : new Date(e.start);
  const evEnd = e => e.allDay ? new Date(e.end + 'T00:00:00') : new Date(e.end);
  const evDay = e => e.allDay ? e.start : mel(new Date(e.start)).key;
  // Days an event touches (all-day events can span several)
  function evDays(e) {
    if (!e.allDay) return [evDay(e)];
    const out = []; let d = e.start;
    while (d < e.end && out.length < 60) { out.push(d); const [y, m, dd] = d.split('-').map(Number); d = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10); }
    return out.length ? out : [e.start];
  }
  function until(ms) {
    const m = Math.max(0, Math.round(ms / 60e3));
    if (m < 1) return 'now';
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return h < 24 ? `in ${h}h${r ? ` ${r}m` : ''}` : `in ${Math.round(m / 1440)} days`;
  }
  const dayWord = key => key === mel().key ? 'today' : key === tomorrowKey() ? 'tomorrow'
    : new Date(key + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long' });
  const calEvents = () => S.cal?.events || [];
  // Next timed event that hasn't finished, plus today's all-day events
  function calUpcoming() {
    const now = Date.now(), today = mel().key;
    const timed = calEvents().filter(e => !e.allDay && evEnd(e).getTime() > now).sort((a, b) => evStart(a) - evStart(b));
    const allDayToday = calEvents().filter(e => e.allDay && evDays(e).includes(today));
    return { timed, allDayToday };
  }
  // Reminders for the notes strip: starting within 2 hours (bold inside 15 min), on now,
  // today's all-day events, and from 6 pm anything tomorrow that's all day or before 9:30 am.
  function calNotes() {
    if (!S.cal) return [];
    const now = Date.now(), m = mel(), out = [];
    const { timed, allDayToday } = calUpcoming();
    for (const e of timed) {
      const st = evStart(e).getTime();
      if (st <= now) out.push({ cls: 'cal', text: `On now: ${e.title} until ${calTime(evEnd(e))}`, href: 'calendar.html', local: true });
      else if (st - now <= 2 * 3600e3) out.push({ cls: st - now <= 15 * 60e3 ? 'cal strong-cal' : 'cal', text: `${e.title} ${until(st - now)} (${calTime(evStart(e))})`, href: 'calendar.html', local: true });
    }
    allDayToday.forEach(e => out.push({ cls: 'cal', text: `Today: ${e.title}`, href: 'calendar.html', local: true }));
    if (m.h >= 18) {
      const tk = tomorrowKey();
      calEvents().filter(e => e.allDay ? e.start === tk : evDay(e) === tk && mel(evStart(e)).hf < 9.5)
        .forEach(e => out.push({ cls: 'cal', text: `Tomorrow${e.allDay ? '' : ' ' + calTime(evStart(e))}: ${e.title}`, href: 'calendar.html', local: true }));
    }
    return out.slice(0, 3);
  }
  // Header "Next up" on the dashboard
  function renderAgenda() {
    const el = $('agenda'); if (!el) return;
    if (!S.cal) {
      el.hidden = !failed.cal;
      if (failed.cal) el.innerHTML = `<b>Calendar</b><span>Can't load right now</span>`;
      return;
    }
    el.hidden = false;
    const { timed, allDayToday } = calUpcoming(), now = Date.now();
    const next = timed[0];
    const later = calEvents().filter(e => e.allDay && e.start > mel().key).sort((a, b) => a.start.localeCompare(b.start))[0];
    let main, sub;
    if (next) {
      const st = evStart(next), on = st.getTime() <= now;
      main = esc(next.title);
      sub = on ? `On now · until ${calTime(evEnd(next))}` : `${dayWord(evDay(next)) === 'today' ? '' : cap(dayWord(evDay(next))) + ' '}${calTime(st)} · ${until(st - now)}`;
    } else if (later) { main = esc(later.title); sub = cap(dayWord(later.start)) + ' · all day'; }
    else { main = 'Nothing coming up'; sub = 'Next two weeks are clear'; }
    const extra = allDayToday.length ? `<em>Today: ${allDayToday.map(e => esc(e.title)).join(', ')}</em>` : '';
    el.innerHTML = `<span class="ag-k">Next up</span><b>${main}</b><span>${esc(sub)}</span>${extra}`;
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- radar (RainViewer, past 2 h, max native zoom 7 on the free tier) ----------
  let map, frames = [], layers = [], idx = 0, playing = true, timer = null;
  function initMap() {
    if (!$('map')) return;
    if (!window.L) { $('map').innerHTML = '<div class="empty" style="position:absolute;inset:0;display:flex">Map library didn\'t load.</div>'; return; }
    const md = $('map').dataset;
    // A page can pin the map to an area (data-bounds="S,W,N,E") and lock it, and give a different
    // area for full screen (data-fs-bounds). The same area then shows whatever size the tile is.
    const toBounds = v => { if (!v) return null; const [s1, w, n, e] = v.split(',').map(Number); return L.latLngBounds([s1, w], [n, e]); };
    const viewB = toBounds(md.bounds), fsB = toBounds(md.fsBounds), locked = md.lock === '1';
    map = L.map('map', { center: md.centre ? md.centre.split(',').map(Number) : RADAR_CENTRE, zoom: md.zoom ? +md.zoom : RADAR_ZOOM, minZoom: 5, maxZoom: 11, zoomControl: false, attributionControl: true, zoomSnap: viewB || fsB ? 1 : 0.5, fadeAnimation: false });   // tile fade-ins pass through partial opacity, which draws seams
    // BoM-style background: Esri's Ocean basemap (blue sea, pale land with relief), keyless.
    // (CARTO stopped serving keyless tiles in 2026; they come back watermarked.)
    const esri = n => `https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/${n}/MapServer/tile/{z}/{y}/{x}`;
    // Esri's Ocean tiles carry a pale one-pixel border on some edges, which shows as faint gridlines.
    // Each tile is redrawn with its outer rows and columns copied from the ones just inside.
    const CleanTiles = L.TileLayer.extend({
      createTile(coords, done) {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => {
          const x = c.getContext('2d'); x.drawImage(img, 0, 0);
          x.drawImage(c, 0, 1, 256, 1, 0, 0, 256, 1); x.drawImage(c, 0, 254, 256, 1, 0, 255, 256, 1);
          x.drawImage(c, 1, 0, 1, 256, 0, 0, 1, 256); x.drawImage(c, 254, 0, 1, 256, 255, 0, 1, 256);
          done(null, c);
        };
        img.onerror = () => done(new Error('map tile'), c);
        img.src = this.getTileUrl(coords);
        return c;
      },
    });
    new CleanTiles(esri('World_Ocean_Base'), { maxZoom: 13, className: 'basemap', attribution: 'Tiles © Esri, GEBCO, NOAA, Garmin, HERE' }).addTo(map);
    // Town names drawn as our own labels above the radar, like the Bureau's maps. (Esri's labels layer
    // left a faint seam along its tile edges.)
    [['Melbourne', -37.8136, 144.9631, 1], ['Geelong', -38.1499, 144.3617, 1], ['Frankston', -38.144, 145.123, 0], ['Dandenong', -37.987, 145.215, 0],
     ['Mornington', -38.218, 145.038, 0], ['Werribee', -37.9, 144.66, 0], ['Sorrento', -38.339, 144.741, 0], ['Cowes', -38.452, 145.238, 0],
     ['Lilydale', -37.757, 145.348, 0], ['Sunbury', -37.577, 144.725, 0], ['Torquay', -38.331, 144.326, 0], ['Pakenham', -38.07, 145.487, 0]]
      .map(t => [...t, 'local'])
      .concat([['Ballarat', -37.562, 143.85, 1], ['Bendigo', -36.757, 144.279, 1], ['Mildura', -34.185, 142.16, 1], ['Shepparton', -36.38, 145.4, 1],
        ['Wodonga', -36.12, 146.888, 1], ['Warrnambool', -38.383, 142.48, 1], ['Traralgon', -38.195, 146.54, 1], ['Horsham', -36.712, 142.2, 1],
        ['Sale', -38.104, 147.068, 0], ['Bairnsdale', -37.823, 147.61, 0], ['Hamilton', -37.744, 142.022, 0], ['Swan Hill', -35.338, 143.554, 0],
        ['Echuca', -36.13, 144.75, 0], ['Wangaratta', -36.358, 146.312, 0], ['Portland', -38.343, 141.604, 0], ['Lakes Entrance', -37.881, 147.981, 0],
        ['Melbourne', -37.8136, 144.9631, 1], ['Geelong', -38.1499, 144.3617, 1]].map(t => [...t, 'state']))
      .forEach(([n, lat, lon, big, set]) => L.marker([lat, lon], { icon: L.divIcon({ className: `town ${set}` + (big ? ' big' : ''), html: `<i></i><span>${n}</span>`, iconSize: null }), keyboard: false, interactive: false, zIndexOffset: -100 }).addTo(map));
    L.marker(HOME, { icon: L.divIcon({ className: '', html: '<div class="home-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), keyboard: false, title: 'Home' }).addTo(map);
    map.attributionControl.addAttribution('Radar <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>');
    // The grid puts the map at fractional pixel positions; on retina screens that makes the browser resample
    // every tile and draws hairline seams along tile edges. Nudge the map onto whole pixels whenever it moves.
    const card = $('map').closest('.radar');
    let fsFitUntil = 0;
    const fitView = () => {
      const fs = card.classList.contains('fs');
      if (fs && Date.now() > fsFitUntil) return;   // in full screen, fit Victoria only while it opens; after that it's yours to zoom
      const b = fs ? (fsB || viewB) : viewB;
      // Whole zoom levels only (in-between zooms scale the tiles and draw hairline seams): the nearest
      // zoom to the area for the dashboard, the one that fits all of it for full-screen Victoria
      if (b) {
        const o = map.options.zoomSnap; map.options.zoomSnap = 0.01;
        const zr = map.getBoundsZoom(b, false, L.point(fs ? 16 : 0, fs ? 16 : 0)); map.options.zoomSnap = o;
        // data-max-zoom caps the pinned view: the free radar stops at zoom 7, so one step past it keeps rain sharp
        const cap = md.maxZoom ? +md.maxZoom : 99;
        map.setView(b.getCenter(), fs ? Math.floor(zr) : Math.min(cap, Math.round(zr)), { animate: false });
      }
      map.getContainer().classList.toggle('state-view', map.getZoom() < 7.6);
    };
    const snapPos = () => {
      const m = $('map'), r = m.parentElement.getBoundingClientRect();
      m.style.left = (Math.round(r.left) - r.left) + 'px';     // full precision: even 0.01 px brings the seams back
      m.style.top = (Math.round(r.top) - r.top) + 'px';
    };
    const snap = () => { snapPos(); map.invalidateSize(); fitView(); };
    // On a phone the page scrolls, and a scroll can leave the map half a pixel off: re-align as it scrolls
    let sf = 0;
    window.addEventListener('scroll', () => { if (!sf) sf = requestAnimationFrame(() => { sf = 0; snapPos(); }); }, { passive: true });
    window.addEventListener('scrollend', snapPos, { passive: true });
    // Locked: no dragging or pinching on the wall screen, so a passing hand can't move it
    const setLock = on => ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard'].forEach(k => map[k] && (on ? map[k].disable() : map[k].enable()));
    if (locked) setLock(true);
    map.on('zoomend', () => map.getContainer().classList.toggle('state-view', map.getZoom() < 7.6));
    new ResizeObserver(snap).observe($('map').parentElement);
    window.addEventListener('resize', snap);
    $('screen')?.addEventListener('transitionend', e => { if (e.target === $('screen')) snap(); });   // after each burn-in nudge (not the map's own zoom animations)
    snap();
    // Tap the map for full screen (tap again, or Esc, to come back). The radar fills the window
    // straight away; on browsers that allow it, it also asks for true full screen.
    let before = null;
    const setFs = on => {
      if (on && !viewB) before = [map.getCenter(), map.getZoom()];
      if (!on && !viewB && before) setTimeout(() => map.setView(before[0], before[1], { animate: false }), 450);
      fsFitUntil = on ? Date.now() + 1200 : 0;
      card.classList.toggle('fs', on);
      if (on) { setLock(false); zoomCtl.addTo(map); } else { zoomCtl.remove(); if (locked) setLock(true); }
      document.body.classList.toggle('radar-fs', on);
      if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      setTimeout(snap, 60); setTimeout(snap, 400);
    };
    // Tap opens full screen. In full screen the map is free to pan and zoom (pinch, scroll, double-tap,
    // or the + and - buttons), so taps there don't close it: the close button or Esc does.
    const zoomCtl = L.control.zoom({ position: 'topright' });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'radar-close'; closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', 'Close full-screen radar'); closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); setFs(false); });
    card.appendChild(closeBtn);
    let down = null;
    $('map').addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    $('map').addEventListener('click', e => {
      if (card.classList.contains('fs')) return;
      if (e.target.closest('.leaflet-control,.radar-bar,a,button')) return;
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;   // that was a drag
      setFs(true);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && card.classList.contains('fs')) setFs(false); });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && card.classList.contains('fs')) setFs(false); });
    let mv; map.on('moveend', () => { clearTimeout(mv); mv = setTimeout(() => loadRadar(false), 500); });   // panned: re-stitch for the new view
  }
  let lastRadar = null, lastSig = '', rainByFrame = [];
  // Radar tile zoom: 7 (the free tier's finest) close in; coarser when zoomed out to the whole state,
  // which looks the same at that scale and keeps a frame to a handful of requests (limit: 100 a minute)
  function tileRange() {
    const b = map.getBounds(), z = Math.max(4, Math.min(NATIVE_Z, Math.floor(map.getZoom() + 0.3)));
    return { z, x0: lon2tile(b.getWest(), z), x1: lon2tile(b.getEast(), z), y0: lat2tile(b.getNorth(), z), y1: lat2tile(b.getSouth(), z) };
  }
  async function loadRadar(refetch = true) {
    if (!map) return;
    const j = refetch ? await pull('radar', API.radar, 15000) : lastRadar;
    const past = j?.radar?.past || [];
    if (!past.length) return;
    lastRadar = j;
    const R = tileRange(), sig = past.map(f => f.path).join() + '|' + JSON.stringify(R);
    if (sig === lastSig) return;                                   // nothing new, nothing moved
    lastSig = sig;
    // Unsmoothed tiles (0_0) so every pixel is an exact palette colour we can convert to BoM's scale
    const built = await Promise.all(past.map(f => buildFrame(j.host, f, R)));
    layers.forEach(l => map.removeLayer(l));
    const keep = new Set(built.map(b => b.key));
    for (const [k, v] of frameCache) if (!keep.has(k)) { URL.revokeObjectURL(v.url); frameCache.delete(k); }
    frames = past;
    layers = built.map(b => b.ov.addTo(map).setZIndex(10));
    rainByFrame = built.map(b => b.rain);
    $('frames').innerHTML = frames.map(() => '<i></i>').join('');
    // Say plainly whether there's any rain in view on the newest frame
    $('rain-state').textContent = rainByFrame[rainByFrame.length - 1] ? '' : 'No rain in view';
    showFrame(frames.length - 1);
  }
  // ---------- BoM-style radar colours ----------
  // RainViewer's free tier only serves its "Universal Blue" palette. Each colour in it stands for one
  // dBZ value (table: rainviewer.com/files/rainviewer_api_colors_table.csv). We read the dBZ back from
  // the colour, convert to rain rate with BoM's own Marshall-Palmer relation (Z = 200 R^1.6) and repaint
  // the pixel in the Bureau's radar colours at its mm/h steps.
  const UB = ['88ddee', '6cd1eb', '51c5e8', '36bae5', '1baee2', '00a3e0', '009ad5', '0091ca', '0088bf', '007fb4',   // 15-24 dBZ
    '0077aa', '0070a3', '00699c', '006295', '005b8e', '005588', '005180', '004e78', '004a70', '004768',           // 25-34
    'ffee00', 'ffe000', 'ffd200', 'ffc500', 'ffb700', 'ffaa00', 'ff9f00', 'ff9500', 'ff8b00', 'ff8100',           // 35-44
    'ff4400', 'f23600', 'e62800', 'd91b00', 'cd0d00', 'c10000', 'a80000', '8f0000', '760000', '5d0000',           // 45-54
    'ffaaff', 'ff9fff', 'ff95ff', 'ff8bff', 'ff81ff', 'ff77ff', 'ff6cff', 'ff62ff', 'ff58ff', 'ff4eff', 'ffffff']; // 55-65
  const UB_LOW = ['ded097', 'dacc93', 'd6c88f', 'd2c48b', 'cec087'];   // 14, 13, 12, 11, 10 dBZ (the beige band)
  const dbzOf = new Map();
  UB.forEach((hex, i) => dbzOf.set(parseInt(hex, 16), 15 + i));
  UB_LOW.forEach((hex, i) => dbzOf.set(parseInt(hex, 16), 14 - i));
  const UB_RGB = [...dbzOf.entries()].map(([k, z]) => [k >> 16, (k >> 8) & 255, k & 255, z]);
  const nearest = new Map();
  function dbzFor(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let z = dbzOf.get(key);
    if (z !== undefined) return z;
    z = nearest.get(key);
    if (z !== undefined) return z;
    let best = 1e9; z = -99;
    for (const [R, G, B, Z] of UB_RGB) { const dd = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2; if (dd < best) { best = dd; z = Z; } }
    if (best > 2500) z = -99;                    // nothing like a radar colour: leave it out
    nearest.set(key, z);
    return z;
  }
  // BoM rain-rate steps (mm/h) and colours, as on the Bureau's radar loops
  const BOM = [[0.2, 'f5f5ff'], [0.5, 'b4b4ff'], [1.5, '7878ff'], [2.5, '1414ff'], [4, '00d8c3'], [6, '009690'], [10, '006666'],
    [15, 'ffff00'], [20, 'ffc800'], [35, 'ff9600'], [50, 'ff6400'], [80, 'ff0000'], [120, 'c80000'], [200, '780000'], [300, '280000']]
    .map(([mm, hex]) => [10 * Math.log10(200 * mm ** 1.6), parseInt(hex, 16)]);
  // Start at 15 dBZ (about 0.3 mm/h), RainViewer's first real rain colour. Below that their composite
  // carries clutter and thin seam lines between radars, which BoM's lightest colour made look like gridlines.
  const MIN_DBZ = 15;
  const bomColour = z => { let c = null; for (const [t, col] of BOM) if (z >= t) c = col; return c; };
  // Each frame is stitched from the zoom-7 tiles covering the view into ONE image (the free tier stops
  // at zoom 7). A single image has no tile edges, so Chrome can't draw hairline seams across the map,
  // which it did with a tiled radar layer however it was scaled.
  const NATIVE_Z = 7;
  const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
  const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
  const lon2tile = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const lat2tile = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
  // Radar tiles are cached once fetched, so panning and zooming in full screen reuses them instead of
  // spending RainViewer's 100-requests-a-minute allowance again (frames older than 2 h drop out anyway)
  const tileCache = new Map();
  const loadImg = src => {
    if (tileCache.has(src)) return tileCache.get(src);
    const p = new Promise((ok, bad) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = bad; im.src = src; });
    p.catch(() => tileCache.delete(src));
    tileCache.set(src, p);
    if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
    return p;
  };
  function recolour(x, w, h) {
    const d = x.getImageData(0, 0, w, h), p = d.data, Z = new Int8Array(w * h).fill(-99);
    for (let i = 0, k = 0; i < Z.length; i++, k += 4) if (p[k + 3]) Z[i] = dbzFor(p[k], p[k + 1], p[k + 2]);
    // RainViewer's composite leaves one-pixel-wide streaks of light echo along the joins between
    // radars, which read as faint gridlines on the map. Real rain is never a single pixel thin, so a
    // light pixel with nothing either side of it (left and right, or above and below) is dropped.
    const on = (i) => Z[i] >= MIN_DBZ;
    const keep = new Uint8Array(Z.length);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      const i = y * w + xx; if (!on(i)) continue;
      if (Z[i] >= 25) { keep[i] = 1; continue; }                   // anything heavier always stays
      const lr = (xx > 0 && on(i - 1)) || (xx < w - 1 && on(i + 1));
      const ud = (y > 0 && on(i - w)) || (y < h - 1 && on(i + w));
      keep[i] = lr && ud ? 1 : 0;
    }
    let rain = 0;
    for (let i = 0, k = 0; i < Z.length; i++, k += 4) {
      const col = keep[i] ? bomColour(Z[i]) : null;
      if (col == null) { p[k + 3] = 0; continue; }
      p[k] = col >> 16; p[k + 1] = (col >> 8) & 255; p[k + 2] = col & 255; p[k + 3] = 255;
      if (Z[i] >= 18) rain++;                // 0.5 mm/h or more counts as rain for the status line
    }
    x.putImageData(d, 0, 0);
    return rain;
  }
  const frameCache = new Map();              // frame path + tile range -> { ov, rain, url }
  async function buildFrame(host, f, R) {
    const key = `${f.path}|${R.z}|${R.x0},${R.y0},${R.x1},${R.y1}`;
    if (frameCache.has(key)) return { key, ...frameCache.get(key) };
    const c = document.createElement('canvas');
    c.width = (R.x1 - R.x0 + 1) * 256; c.height = (R.y1 - R.y0 + 1) * 256;
    const x = c.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let tx = R.x0; tx <= R.x1; tx++) for (let ty = R.y0; ty <= R.y1; ty++) {
      jobs.push(loadImg(`${host}${f.path}/256/${R.z}/${tx}/${ty}/2/0_0.png`).then(im => x.drawImage(im, (tx - R.x0) * 256, (ty - R.y0) * 256)).catch(() => {}));
    }
    await Promise.all(jobs);
    let rain = 0;
    try { rain = recolour(x, c.width, c.height); } catch (e) { /* CORS refused: unconverted colours */ }
    const url = await new Promise(ok => c.toBlob(b => ok(URL.createObjectURL(b))));
    const bounds = L.latLngBounds([tile2lat(R.y1 + 1, R.z), tile2lon(R.x0, R.z)], [tile2lat(R.y0, R.z), tile2lon(R.x1 + 1, R.z)]);
    const ov = L.imageOverlay(url, bounds, { opacity: 0, pane: 'tilePane', className: 'radar-img', interactive: false });
    const out = { ov, rain, url };
    frameCache.set(key, out);
    return { key, ...out };
  }

  function showFrame(i) {
    if (!layers.length) return;
    layers.forEach((l, k) => l.setOpacity(k === i ? 1 : 0));
    idx = i;
    [...$('frames').children].forEach((el, k) => el.className = k === i ? 'on' : k < i ? 'past' : '');
    const latest = i === frames.length - 1;
    $('radar-time').textContent = clock(new Date(frames[i].time * 1000)) + (latest ? ' ●' : '');
    $('radar-time').title = latest ? 'Latest frame' : '';
  }
  function tick() {
    if (!playing || !layers.length || document.hidden) return;
    const next = (idx + 1) % layers.length;
    showFrame(next);
    // hold on the latest frame so it's readable at a glance
    timer = setTimeout(tick, next === layers.length - 1 ? 2600 : 550);
  }
  function setPlaying(p) {
    playing = p; clearTimeout(timer);
    $('radar-icon').innerHTML = p ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>' : '<path d="M7 5l12 7-12 7z"/>';
    $('radar-play').setAttribute('aria-label', p ? 'Pause radar animation' : 'Play radar animation');
    if (p) timer = setTimeout(tick, 600); else showFrame(layers.length - 1);
  }
  $('radar-play')?.addEventListener('click', () => setPlaying(!playing));
  $('frames')?.addEventListener('click', ev => { const i = [...$('frames').children].indexOf(ev.target); if (i >= 0) { setPlaying(false); showFrame(i); } });

  // ---------- wall-display behaviour (dashboard only) ----------
  let WALL = false;
  // Keep the screen awake (needs a tap first on some browsers)
  let lock = null;
  async function wake() { try { if ('wakeLock' in navigator && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => lock = null); } } catch (e) {} }
  // Night dimming 10 pm to 6 am. Tap anywhere to brighten for a minute. ?dim=off disables.
  let dimMode = params.get('dim') === 'off' ? 'off' : 'auto', wakeUntil = 0;
  function applyDim() {
    if (!WALL) return;
    const h = mel().h, night = h >= 22 || h < 6;
    document.body.classList.toggle('dimmed', dimMode === 'on' || (dimMode === 'auto' && night && Date.now() > wakeUntil));
  }
  function startWall() {
    WALL = true;
    document.addEventListener('click', wake, { passive: true });
    document.addEventListener('pointerdown', () => { wakeUntil = Date.now() + 60e3; applyDim(); }, { passive: true });
    $('btn-dim').addEventListener('click', ev => { ev.stopPropagation(); dimMode = dimMode === 'auto' ? 'on' : dimMode === 'on' ? 'off' : 'auto'; $('btn-dim').title = 'Night dimming: ' + dimMode; wakeUntil = 0; applyDim(); });
    $('btn-fs').addEventListener('click', () => { const d = document; (d.fullscreenElement ? d.exitFullscreen() : d.documentElement.requestFullscreen?.())?.catch?.(() => {}); });
    // Nudge the whole layout by a pixel or two every few minutes (burn-in protection)
    const shifts = [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2]];
    let si = 0; setInterval(() => { si = (si + 1) % shifts.length; $('screen').style.transform = `translate(${shifts[si][0]}px,${shifts[si][1]}px)`; }, 4 * 60e3);
    // Full reload every 6 hours to pick up deploys and keep memory tidy
    setTimeout(() => location.reload(), 6 * 3600e3);
    wake();
  }

  // ---------- loops ----------
  let EXTRA = [];
  const renderAll = () => {
    for (const fn of [renderClock, renderWx, renderFlow, renderEff, renderPies, renderCars, renderNet, renderForecast, renderClimate, renderAgenda, renderNotes, ...EXTRA]) {
      try { fn(); } catch (e) { console.warn('render', fn.name, e); }
    }
  };
  async function refresh(name) {
    if (name === 'radar') return loadRadar();
    if (name === 'climate') await pullClimate(); else await pull(name, API[name]);
    renderAll();
  }
  function schedule(name) { setInterval(() => { if (!document.hidden) refresh(name); }, EVERY[name]); }
  function start({ sources = ['ev', 'sems', 'wx', 'fc', 'net', 'warn', 'radar'], wall = false, extra = [] } = {}) {
    EXTRA = extra;
    sources.filter(n => n !== 'radar').forEach(n => { refresh(n); schedule(n); });
    if (sources.includes('radar')) { initMap(); loadRadar().then(() => setPlaying(true)); schedule('radar'); }
    setInterval(() => { renderClock(); renderDots(); applyDim(); }, 10e3);
    setInterval(() => { renderNotes(); renderAgenda(); }, 60e3);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { lock = null; return; }
      if (WALL) wake();
      ['ev', 'wx'].filter(n => sources.includes(n)).forEach(refresh);
      if (map && playing) setPlaying(true);
    });
    if (wall) startWall();
    renderClock(); applyDim();
    let rs; window.addEventListener('resize', () => { clearTimeout(rs); rs = setTimeout(renderAll, 200); });
  }

  return { start, renderAll, S, at, failed, API, STALE, $, TZ, HOME, PANEL_KW, PR, RATE, fcKw,
    mel, tomorrowKey, clock, ampm, ago, fcHour, has, f0, f1, kw, esc,
    icon, hourKind, dayKind, dayIcon, KIND_TXT, fcDays, solarScore, scoreColor, todayHourly, nextHours, isNight,
    cardinal, uvLabel, windArrow, WIND_ALERT, UV_ALERT, maxGust12, next12Range,
    energyNow, allocate, todayTotals, excessSolar, donut, legend, warnNotes, CARS, plugState, carOnCharger, chargeSource, hm,
    climateSummary, ZONES, todayOutlook, ADVICE_CLS, solarLeftToday,
    calEvents, calTime, evStart, evEnd, evDay, evDays, until, dayWord, hubKey, refresh };
})();
