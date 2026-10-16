#!/usr/bin/env node
// Static server for the app that also lets the page save downloaded sessions into data/.
//   node scripts/serve.mjs [port]      then open http://localhost:8765
// Writes are limited to PUT /data/[<session_key>/]<name>.json from this machine.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 8765;
const MAX_BODY = 200 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".md": "text/plain; charset=utf-8" };
const SAVE_PATH = /^\/data\/(\d{4}\/\d+\/|circuits\/)?[\w.-]+\.json$/;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const host = (req.headers.host || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") { res.writeHead(403).end(); return; } // blocks DNS-rebinding
  try {
    if (req.method === "PUT" && SAVE_PATH.test(url.pathname)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) { res.writeHead(403).end(); return; }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
      const body = Buffer.concat(chunks); JSON.parse(body); // must be valid JSON
      const file = path.join(ROOT, url.pathname);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
      res.writeHead(204).end(); return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    if (url.pathname === "/__can_save") { res.writeHead(204).end(); return; }
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || /(^|[\/])(scripts|\.)/.test(path.relative(ROOT, file))) { res.writeHead(404).end(); return; }
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }).end(data);
  } catch (e) { res.writeHead(e.code === "ENOENT" ? 404 : 400).end(); }
}).listen(PORT, "127.0.0.1", () => console.log(`GRIDLINE on http://localhost:${PORT} (saving to ${path.join(ROOT, "data")})`));
