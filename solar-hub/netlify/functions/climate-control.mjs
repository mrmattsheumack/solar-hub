// netlify/functions/climate-control.mjs: runs the room airflow controller every 5 minutes.
// Logic and safety rules are in ../climate-core.mjs. Settings/state/log live in the "climate" blob store.
import { getStore } from "@netlify/blobs";
import { runController, realIO } from "../climate-core.mjs";

export default async (req, context) => {
  const store = getStore("climate");
  const { io, ...rw } = realIO(store, context?.site?.url);
  try {
    const { status } = await runController({ io, ...rw, trigger: "schedule" });
    console.log("climate-control", JSON.stringify(status));
  } catch (e) {
    console.error("climate-control failed", e);
  }
  return new Response("ok");
};

export const config = { schedule: "*/5 * * * *" };
