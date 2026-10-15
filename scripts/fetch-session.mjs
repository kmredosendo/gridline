#!/usr/bin/env node
// Downloads everything the replay needs for one or more sessions into data/<session_key>/ so the
// app can load them from disk instead of the live API.
//   node scripts/fetch-session.mjs 9693 9523        # by session key
//   node scripts/fetch-session.mjs --year 2024      # every Race + Sprint of a season
//   node scripts/fetch-session.mjs --standings-only # add championship standings to every cached session
//   node scripts/fetch-session.mjs --car-data-only  # add speed telemetry (car-<n>.json) to every cached session
//   add --force to re-download sessions that are already cached
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.openf1.org/v1";
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const PRE_S = 600, POST_S = 300; // wider than the app's window; the app clips on load
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pause = () => sleep(250); // be gentle with the public API
const iso = ms => new Date(ms).toISOString().slice(0, 19);

async function get(query, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    await pause();
    const res = await fetch(`${API}/${query}`).catch(e => ({ ok: false, status: 0, err: e }));
    if (res.ok) return res.json();
    if (res.status === 404) return []; // OpenF1 answers 404 when a query matches nothing
    if (i < attempts - 1) await sleep(1500 * (i + 1) * (res.status === 429 ? 3 : 1));
    else throw new Error(`${query}: HTTP ${res.status || res.err}`);
  }
}
const write = (file, obj) => fs.writeFile(file, JSON.stringify(obj));

// Location as columns, with the feed's (0,0) "no fix" placeholders dropped.
function columns(points) {
  const rows = points.map(p => [Date.parse(p.date), +p.x, +p.y]).filter(r => Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]) && (r[1] || r[2])).sort((a, b) => a[0] - b[0]);
  return { t: rows.map(r => r[0]), x: rows.map(r => r[1]), y: rows.map(r => r[2]) };
}

// car_data is ~6 MB/driver as API JSON; keep only speed, with delta-encoded times: {t0, dt[], s[]} (~0.25 MB).
function packCar(rows) {
  const r = rows.map(x => [Date.parse(x.date), Number(x.speed)]).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1])).sort((a, b) => a[0] - b[0]);
  return { t0: r[0]?.[0] ?? 0, dt: r.map((x, i) => i ? x[0] - r[i - 1][0] : 0), s: r.map(x => Math.round(x[1])) };
}
async function fetchCar(dir, sk, nums, win, force) {
  for (const n of nums) {
    const f = path.join(dir, `car-${n}.json`);
    if (!force && await fs.access(f).then(() => true, () => false)) continue;
    const loc = await fs.readFile(path.join(dir, `location-${n}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (!loc?.t?.length) continue; // car never ran (DNS): no telemetry either
    const c = packCar(await get(`car_data?session_key=${sk}&driver_number=${n}&${win}`));
    await write(f, c); console.log(`  car ${n}: ${c.s.length} samples`);
  }
}

async function fetchSession(sk, force) {
  const idxFile = path.join(DATA, "index.json");
  const index = await fs.readFile(idxFile, "utf8").then(JSON.parse).catch(() => ({ sessions: {} }));
  if (index.sessions[sk] && !force) { console.log(`${sk}: already cached (use --force to refresh)`); return; }
  const [session] = await get(`sessions?session_key=${sk}`);
  if (!session) throw new Error(`${sk}: session not found`);
  const dir = path.join(DATA, String(session.year), String(sk)); // data/<season>/<session_key>/
  await fs.mkdir(dir, { recursive: true });
  const [meeting] = await get(`meetings?meeting_key=${session.meeting_key}`);
  console.log(`${sk}: ${session.year} ${meeting?.meeting_name ?? ""} — ${session.session_name}`);
  const q = `session_key=${sk}`;
  const drivers = await get(`drivers?${q}`);
  const rc = await get(`race_control?${q}`);
  await write(path.join(dir, "drivers.json"), drivers);
  await write(path.join(dir, "race_control.json"), rc);
  for (const name of ["position", "laps", "session_result", "intervals", "pit", "weather", "stints", "championship_drivers", "championship_teams"]) {
    await write(path.join(dir, `${name}.json`), await get(`${name}?${q}`));
    console.log(`  ${name}`);
  }
  // Same time origin / end rule as the app: SESSION STARTED .. SESSION FINISHED.
  const t = re => rc.find(e => re.test(e.message || ""))?.date;
  const started = Date.parse(t(/SESSION STARTED/i) ?? session.date_start);
  const finished = Date.parse(t(/SESSION FINISHED/i) ?? session.date_end);
  const win = `date>=${iso(started - PRE_S * 1000)}&date<${iso(finished + POST_S * 1000)}`;
  const nums = new Set(drivers.map(d => Number(d.driver_number)));
  for (const n of nums) {
    const cols = columns(await get(`location?${q}&driver_number=${n}&${win}`));
    await write(path.join(dir, `location-${n}.json`), cols);
    console.log(`  location ${n}: ${cols.t.length} samples`);
  }
  // OpenF1 sometimes has GPS for only part of a race (e.g. 2026 Monaco). Don't cache a partial race.
  let lastGps = 0;
  for (const n of nums) { const c = JSON.parse(await fs.readFile(path.join(dir, `location-${n}.json`), "utf8")); if (c.t.length) lastGps = Math.max(lastGps, c.t.at(-1)); }
  if (lastGps < finished - 5 * 60000) {
    await fs.rm(dir, { recursive: true, force: true });
    console.log(`  SKIPPED: GPS ends ${Math.round((finished - lastGps) / 60000)} min before the race does (partial data not cached)`);
    return;
  }
  await fetchCar(dir, sk, nums, win, force);
  // Non-driver cars (the safety car is a pseudo-driver): look in a short window after each
  // safety-car deployment for car numbers that are not on the entry list.
  const extra = new Set();
  for (const e of rc.filter(e => e.category === "SafetyCar" && /DEPLOYED/i.test(e.message || "")).slice(0, 3)) {
    const t0 = Date.parse(e.date) + 30000;
    const rows = await get(`location?${q}&date>=${iso(t0)}&date<${iso(t0 + 5000)}`);
    for (const r of rows) if (!nums.has(Number(r.driver_number)) && (r.x || r.y)) extra.add(Number(r.driver_number));
  }
  for (const n of extra) {
    const cols = columns(await get(`location?${q}&driver_number=${n}&${win}`));
    await write(path.join(dir, `location-${n}.json`), cols);
    console.log(`  extra car ${n}: ${cols.t.length} samples`);
  }
  await write(path.join(dir, "meta.json"), { session, meeting: meeting ?? null, extra: [...extra], window: { started, finished } });
  index.sessions[sk] = { year: session.year, name: `${meeting?.meeting_name ?? session.location} — ${session.session_name}`, fetched: new Date().toISOString() };
  await write(idxFile, index); // written per session so an interrupted run keeps what finished
}

const args = process.argv.slice(2), force = args.includes("--force"), standingsOnly = args.includes("--standings-only"), carOnly = args.includes("--car-data-only");
// "--year 2024" takes the next argument as a season; every other bare number is a session key.
const keys = [], years = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--year") years.push(args[++i]);
  else if (/^\d+$/.test(args[i])) keys.push(Number(args[i]));
}
for (const y of years) {
  const sessions = await get(`sessions?year=${y}`);
  keys.push(...sessions.filter(s => (s.session_name === "Race" || s.session_name === "Sprint") && !s.is_cancelled && Date.parse(s.date_start) < Date.now()).map(s => s.session_key));
}
if (carOnly) {
  // Top up already-cached sessions with speed telemetry only (no location re-download). Resumable.
  const index = await fs.readFile(path.join(DATA, "index.json"), "utf8").then(JSON.parse);
  for (const [sk, v] of Object.entries(index.sessions)) {
    if (keys.length && !keys.includes(Number(sk))) continue;
    const dir = path.join(DATA, String(v.year), sk);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
      const drivers = JSON.parse(await fs.readFile(path.join(dir, "drivers.json"), "utf8"));
      const win = `date>=${iso(meta.window.started - PRE_S * 1000)}&date<${iso(meta.window.finished + POST_S * 1000)}`;
      console.log(`${sk}: ${v.name}`);
      await fetchCar(dir, sk, new Set(drivers.map(d => Number(d.driver_number))), win, force);
    } catch (e) { console.error(`${sk}: FAILED — ${e.message}`); process.exitCode = 1; }
  }
  process.exit();
}
if (standingsOnly) {
  // Top up already-cached sessions with the championship standings only (no location re-download).
  const index = await fs.readFile(path.join(DATA, "index.json"), "utf8").then(JSON.parse);
  for (const [sk, v] of Object.entries(index.sessions)) {
    if (keys.length && !keys.includes(Number(sk))) continue;
    const dir = path.join(DATA, String(v.year), sk);
    for (const name of ["championship_drivers", "championship_teams"]) {
      if (!force && await fs.access(path.join(dir, `${name}.json`)).then(() => true, () => false)) continue;
      try { await write(path.join(dir, `${name}.json`), await get(`${name}?session_key=${sk}`)); } catch (e) { console.error(`${sk} ${name}: FAILED — ${e.message}`); process.exitCode = 1; }
    }
    console.log(`${sk}: ${v.name}`);
  }
  process.exit();
}
if (!keys.length) { console.error("usage: node scripts/fetch-session.mjs <session_key...> | --year <YYYY> [--force] | --standings-only | --car-data-only [session_key...]"); process.exit(1); }
await fs.mkdir(DATA, { recursive: true });
for (const k of keys) { try { await fetchSession(k, force); } catch (e) { console.error(`${k}: FAILED — ${e.message}`); process.exitCode = 1; } }
