// netlify/blobs.mjs: the blob store the climate functions use.
// On Netlify it is Netlify Blobs (vendored client). On the Pi (pi/site-server sets SITE_STORE_DIR)
// it is a folder of JSON files, one per key, written atomically, so reads always see the last write.
import fs from "node:fs/promises";
import path from "node:path";
import { getStore as netlifyGetStore } from "./vendor/netlify-blobs-8.2.0.mjs";

const DIR = process.env.SITE_STORE_DIR;

function fileStore(name) {
  const dir = path.join(DIR, name.replace(/[^a-z0-9_-]/gi, "_"));
  const file = k => path.join(dir, encodeURIComponent(k) + ".blob");
  const read = async k => { try { return await fs.readFile(file(k)); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  const write = async (k, data) => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = file(k) + "." + process.pid + "." + Date.now() + ".tmp";
    await fs.writeFile(tmp, data); await fs.rename(tmp, file(k));
  };
  return {
    async get(k, opts = {}) {
      const b = await read(k); if (b == null) return null;
      if (opts.type === "json") return JSON.parse(b.toString("utf8"));
      if (opts.type === "arrayBuffer") return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      if (opts.type === "blob") return new Blob([b]);
      return b.toString("utf8");
    },
    async getJSON(k) { return this.get(k, { type: "json" }); },
    async set(k, v) { await write(k, typeof v === "string" ? v : Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v)); },
    async setJSON(k, v) { await write(k, JSON.stringify(v)); },
    async delete(k) { await fs.rm(file(k), { force: true }); },
    async list() {
      let names = []; try { names = await fs.readdir(dir); } catch {}
      return { blobs: names.filter(n => n.endsWith(".blob")).map(n => ({ key: decodeURIComponent(n.slice(0, -5)) })), directories: [] };
    },
  };
}

export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  return DIR ? fileStore(name) : netlifyGetStore(opts);
}
