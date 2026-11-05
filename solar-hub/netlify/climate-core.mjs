// climate-core.mjs: the room airflow controller (shared by the climate and climate-control functions).
//
// What it does, every 5 minutes (scheduled) or when the dashboard asks:
//   For each room whose control is switched on and that has a fresh room sensor reading, it nudges that
//   zone's Max Air on the iZone (0-100 in 5 % steps) towards the room's target:
//     heating: colder than target -> more air, warmer -> less air (cooling the other way round).
//   An open iZone zone without iZone sensors sits its damper at Max Air, so Max Air is the room's airflow dial.
//
// It never touches: rooms with control off (they keep whatever the iZone has), zone open/close, the AC's
// power, mode, fan or setpoint.
//
// Safety:
//   - only when the AC is on in Heat or Cool, the zone is open, and the reading is under 15 minutes old
//   - one change per room per 10 minutes, at most 10 % at a time, within the room's min/max (default 10-80 %)
//   - if Max Air was changed by someone else (iZone app, wall panel, dashboard slider) it leaves that room
//     alone for 2 hours and takes the new value as its starting point
//   - when control of a room is switched off it puts Max Air back to what it was before control started,
//     or to the last value a person set by hand (and leaves it alone if someone changed it since)
//
// I/O is passed in (io, readSensors, readZone, readSystem, setMaxAir) so the logic can be tested offline.

export const ROOMS = [
  { id: "lounge", name: "Lounge", zone: 1 },
  { id: "master", name: "Master", zone: 2 },
  { id: "charlie", name: "Charlie's", zone: 3 },
  { id: "mila", name: "Mila's", zone: 4 },
  { id: "office", name: "Office", zone: 5 },
  { id: "bath", name: "Bathroom", zone: 6 },
];

// Targets match the Climate Control page's defaults. Control starts on for Mila's only (5 Nov 2026:
// the one WN31 room sensor). The Lounge reads the Ecowitt console's own sensor, which is 1-2 degrees off
// its screen and sits by the AC's return air, so it stays watch-only until that is sorted.
export const DEFAULT_SETTINGS = {
  enabled: true,
  rooms: {
    lounge: { control: false, target: 22, minAir: 10, maxAir: 100 },
    master: { control: false, target: 20, minAir: 10, maxAir: 80 },
    charlie: { control: false, target: 21, minAir: 10, maxAir: 80 },
    mila: { control: true, target: 21, minAir: 10, maxAir: 80 },
    office: { control: false, target: 22, minAir: 10, maxAir: 80 },
    bath: { control: false, target: 22, minAir: 10, maxAir: 80 },
  },
};

export const RULES = {
  staleMs: 15 * 60e3,          // sensor reading older than this: hold
  minGapMs: 10 * 60e3,         // at most one change per room per 10 minutes
  pauseMs: 2 * 3600e3,         // after a change by someone else, leave the room alone for 2 hours
  deadband: 0.3,               // within +/-0.3 degrees of target: hold
  bigError: 1.0,               // 1 degree or more away: 10 % step, otherwise 5 %
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round5 = v => Math.round(v / 5) * 5;
const isNum = v => typeof v === "number" && Number.isFinite(v);

export function mergeSettings(saved) {
  const s = { enabled: DEFAULT_SETTINGS.enabled, rooms: {} };
  if (saved && typeof saved.enabled === "boolean") s.enabled = saved.enabled;
  for (const r of ROOMS) s.rooms[r.id] = { ...DEFAULT_SETTINGS.rooms[r.id], ...((saved && saved.rooms && saved.rooms[r.id]) || {}) };
  return s;
}

// Validates and applies a settings change from the dashboard. Returns the new settings.
export function applySettingsChange(settings, change) {
  const s = mergeSettings(settings);
  if (typeof change.enabled === "boolean") s.enabled = change.enabled;
  if (change.room) {
    const r = s.rooms[change.room];
    if (!r) throw new Error("unknown room " + change.room);
    if (typeof change.control === "boolean") r.control = change.control;
    if (isNum(change.target)) r.target = clamp(Math.round(change.target * 2) / 2, 16, 28);
    if (isNum(change.minAir)) r.minAir = clamp(round5(change.minAir), 0, 100);
    if (isNum(change.maxAir)) r.maxAir = clamp(round5(change.maxAir), 0, 100);
    if (r.minAir > r.maxAir) r.minAir = r.maxAir;
  }
  s.updatedAt = new Date().toISOString();
  return s;
}

// Decide what to do for one controlled room. Pure: returns { step, reason } with step in % (can be 0).
export function decide({ temp, target, acMode }) {
  const err = acMode === "cool" ? temp - target : target - temp;   // > 0 means the room needs more air
  const a = Math.abs(err);
  if (a <= RULES.deadband) return { step: 0, err, reason: "on target" };
  const size = a >= RULES.bigError ? 10 : 5;
  return { step: err > 0 ? size : -size, err, reason: err > 0 ? "below target" : "above target" };
}

const AC_MODES = { 1: "cool", 2: "heat", 3: "fan", 4: "dry", 5: "auto", 6: "exhaust", 7: "pump" };

export async function runController({ io, readSensors, readSystem, readZone, setMaxAir, now = Date.now(), trigger = "schedule" }) {
  const settings = mergeSettings(await io.get("settings"));
  const state = (await io.get("state")) || {};
  const log = [];
  const status = { at: new Date(now).toISOString(), trigger, enabled: settings.enabled, rooms: {}, errors: [] };

  const note = (room, action, text, extra = {}) => log.push({ ts: new Date(now).toISOString(), room: room.id, name: room.name, action, text, ...extra });

  // Rooms that need the iZone this run: controlled ones, and ones we were controlling (to put back)
  const active = ROOMS.filter(r => (settings.enabled && settings.rooms[r.id].control) || isNum(state[r.id]?.lastSet));
  if (!active.length) {
    await io.set("status", status);
    return { status, log, settings };
  }

  let sys = null, sensors = {};
  try { sys = await readSystem(); } catch (e) { status.errors.push("iZone: " + e.message); }
  try { sensors = (await readSensors()) || {}; } catch (e) { status.errors.push("sensors: " + e.message); }
  const acMode = sys ? AC_MODES[sys.SysMode] || "?" : null;
  status.ac = sys ? { on: sys.SysOn === 1, mode: acMode, setpoint: isNum(sys.Setpoint) ? sys.Setpoint / 100 : null } : null;

  for (const room of active) {
    const cfg = settings.rooms[room.id];
    const st = state[room.id] = state[room.id] || {};
    const controlling = settings.enabled && cfg.control;
    const rs = { control: controlling, target: cfg.target, minAir: cfg.minAir, maxAir: cfg.maxAir };
    status.rooms[room.id] = rs;

    let zone = null;
    try { zone = await readZone(room.zone - 1); } catch (e) { status.errors.push(`${room.name} zone: ${e.message}`); }
    const max = zone && isNum(zone.MaxAir) ? zone.MaxAir : null;
    rs.airflow = max;
    const hold = (reason) => {
      rs.action = "hold"; rs.reason = reason;
      if (st.lastReason !== reason) { note(room, "hold", reason, { airflow: max }); st.lastReason = reason; }
    };

    // Control switched off (or the whole controller off): put the room back as we found it
    if (!controlling) {
      if (max != null && isNum(st.baseline) && max === st.lastSet && st.baseline !== max) {
        try {
          await setMaxAir(room.zone - 1, st.baseline);
          note(room, "restore", `Control off: airflow back to ${st.baseline}% (was ${max}%)`, { from: max, to: st.baseline });
          rs.airflow = st.baseline;
        } catch (e) { status.errors.push(`${room.name} restore: ${e.message}`); continue; }
      } else if (isNum(st.lastSet)) {
        note(room, "release", `Control off: airflow left at ${max ?? "?"}%`, { airflow: max });
      }
      if (max != null || !isNum(st.lastSet)) delete state[room.id];
      rs.action = "off"; rs.reason = "control off";
      continue;
    }

    if (max == null) { hold("no reading from the iZone for this zone"); continue; }

    // Someone else changed Max Air since our last change: back off for 2 hours
    if (isNum(st.lastSet) && max !== st.lastSet) {
      st.pausedUntil = now + RULES.pauseMs;
      note(room, "paused", `Airflow changed to ${max}% outside the controller (was ${st.lastSet}%). Leaving ${room.name} alone until ${new Date(st.pausedUntil).toLocaleTimeString("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit" })}.`, { airflow: max });
      st.lastSet = max;
      st.baseline = max;     // a person's choice is what to go back to when control is switched off
      st.lastReason = null;
    }
    if (!isNum(st.baseline)) st.baseline = max;     // what to put back when control is switched off
    if (!isNum(st.lastSet)) st.lastSet = max;

    const s = sensors[room.id];
    const age = s && s.last_update_iso ? now - Date.parse(s.last_update_iso) : Infinity;
    rs.temp = s && isNum(s.temp) ? s.temp : null;
    rs.readingAt = s?.last_update_iso || null;

    if (st.pausedUntil && now < st.pausedUntil) { hold(`paused after a manual change, until ${new Date(st.pausedUntil).toLocaleTimeString("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit" })}`); rs.pausedUntil = new Date(st.pausedUntil).toISOString(); continue; }
    if (st.pausedUntil) delete st.pausedUntil;
    if (!sys) { hold("can't read the AC right now"); continue; }
    if (sys.SysOn !== 1) { hold("AC is off"); continue; }
    if (acMode !== "heat" && acMode !== "cool") { hold(`AC is in ${acMode} mode`); continue; }
    if (zone.Mode !== 1) { hold("zone is closed"); continue; }
    if (!s || !isNum(s.temp)) { hold("no room sensor reading"); continue; }
    if (!(age < RULES.staleMs)) { hold("room sensor reading is out of date"); continue; }

    const d = decide({ temp: s.temp, target: cfg.target, acMode });
    rs.err = +d.err.toFixed(2);
    if (d.step === 0) { hold(`${s.temp.toFixed(1)}° is on target (${cfg.target}°)`); continue; }
    const want = clamp(round5(max + d.step), cfg.minAir, cfg.maxAir);
    if (want === max) { hold(`${s.temp.toFixed(1)}° is ${d.reason} (${cfg.target}°) but airflow is already at its ${d.step > 0 ? "max" : "min"} of ${max}%`); continue; }
    if (st.lastChangeAt && now - st.lastChangeAt < RULES.minGapMs) { rs.action = "wait"; rs.reason = "waiting 10 minutes between changes"; continue; }

    try {
      await setMaxAir(room.zone - 1, want);
      st.lastSet = want; st.lastChangeAt = now; st.lastReason = null;
      rs.airflow = want; rs.action = want > max ? "up" : "down";
      rs.reason = `${s.temp.toFixed(1)}° vs ${cfg.target}° target`;
      note(room, rs.action, `${s.temp.toFixed(1)}° vs ${cfg.target}° target (${acMode}): airflow ${max}% → ${want}%`, { from: max, to: want, temp: s.temp, target: cfg.target });
    } catch (e) {
      status.errors.push(`${room.name} set airflow: ${e.message}`);
      hold("the iZone didn't accept the change");
    }
  }

  await io.set("state", state);
  await io.set("status", status);
  if (log.length) {
    const old = (await io.get("log")) || [];
    await io.set("log", [...log.reverse(), ...old].slice(0, 300));
  }
  return { status, log, settings };
}

// ---------- real I/O (used by the Netlify functions) ----------
const BRIDGE_URL_DEFAULT = "https://eaglecam.taile03fa1.ts.net";
const env = k => (globalThis.Netlify?.env?.get?.(k)) ?? process.env[k];

async function bridgePost(path, body, ms) {
  const token = env("BRIDGE_TOKEN");
  if (!token) throw new Error("BRIDGE_TOKEN not set");
  const r = await fetch((env("BRIDGE_URL") || BRIDGE_URL_DEFAULT) + path, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`bridge ${path} HTTP ${r.status}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function realIO(store, siteUrl) {
  const base = siteUrl || env("URL") || "https://solarhubdromana.netlify.app";
  return {
    io: {
      get: k => store.get(k, { type: "json" }),
      set: (k, v) => store.setJSON(k, v),
    },
    readSystem: async () => {
      const j = await bridgePost("/api/izone/query", { iZoneV2Request: { Type: 1, No: 0, No1: 0 } }, 6000);
      if (!j.SystemV2) throw new Error("no system data");
      return j.SystemV2;
    },
    readZone: async (i) => {
      const j = await bridgePost("/api/izone/query", { iZoneV2Request: { Type: 2, No: i, No1: 0 } }, 6000);
      const z = j.ZonesV2 || j;
      if (!z || z.Index !== i) throw new Error("no zone data");
      return z;
    },
    setMaxAir: async (i, pct) => {
      const j = await bridgePost("/api/izone/command", { ZoneMaxAir: { Index: i, MaxAir: pct } }, 6000);
      const raw = String(j.raw ?? "");
      if (/ERROR/i.test(raw)) throw new Error("iZone said " + raw);
      return j;
    },
    readSensors: async () => {
      const r = await fetch(base + "/.netlify/functions/ecowitt", { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error("ecowitt HTTP " + r.status);
      return (await r.json()).rooms || {};
    },
  };
}
