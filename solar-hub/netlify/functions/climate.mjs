// netlify/functions/climate.mjs: the Climate Control page's link to the room airflow controller.
//   GET                                  -> { settings, status, state, log }
//   POST { action: "settings", enabled?, room?, control?, target?, minAir?, maxAir? }  -> save, then run a check
//   POST { action: "airflow", room, maxAir }  -> set a zone's Max Air by hand (any room). On a controlled room
//                                               the controller sees it as a manual change and leaves the room for 2 h.
//   POST { action: "run" }               -> run a check now
// Controller logic and safety rules: ../climate-core.mjs.
import { getStore } from "../vendor/netlify-blobs-8.2.0.mjs";
import { runController, realIO, mergeSettings, applySettingsChange, ROOMS } from "../climate-core.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req, context) => {
  const store = getStore({ name: "climate", consistency: "strong" });
  const { io, ...rw } = realIO(store, context?.site?.url, getStore("climate"));
  const snapshot = async (extra = {}) => json({
    settings: mergeSettings(await io.get("settings")),
    status: await io.get("status"),
    state: await io.get("state"),
    log: ((await io.get("log")) || []).slice(0, 60),
    ...extra,
  });

  try {
    if (req.method === "GET") return await snapshot();
    if (req.method !== "POST") return json({ error: "GET or POST" }, 405);
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }

    if (body.action === "settings") {
      const next = applySettingsChange(await io.get("settings"), body);
      await io.set("settings", next);
      const run = await runController({ io, ...rw, trigger: "settings" });
      return await snapshot({ ran: run.status });
    }
    if (body.action === "airflow") {
      const room = ROOMS.find(r => r.id === body.room);
      const pct = Math.round(Number(body.maxAir) / 5) * 5;
      if (!room || !(pct >= 0 && pct <= 100)) return json({ error: "room and maxAir 0-100 needed" }, 400);
      await rw.setMaxAir(room.zone - 1, pct);
      const log = (await io.get("log")) || [];
      log.unshift({ ts: new Date().toISOString(), room: room.id, name: room.name, action: "manual", text: `Airflow set to ${pct}% from the dashboard`, to: pct });
      await io.set("log", log.slice(0, 300));
      return await snapshot({ set: { room: room.id, maxAir: pct } });
    }
    if (body.action === "run") {
      const run = await runController({ io, ...rw, trigger: "dashboard" });
      return await snapshot({ ran: run.status });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
