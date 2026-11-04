/**
 * AUREUS API + autonomous loop, for the dashboard. Runs locally or hosted (Render).
 *
 * Security:
 * - Every request except /api/health needs "Authorization: Bearer <AUREUS_DASHBOARD_TOKEN>".
 * - Browser origins are limited to AUREUS_ALLOWED_ORIGINS (your Lovable domain).
 * - The API can never trade. "Run dry cycle" is always quotes-only. Real trades only
 *   happen in the autonomous loop, and only when AUREUS_EXECUTE=true.
 * - Keys are never returned. A memo is decrypted only on an explicit disclose request.
 *
 * Hosting env:
 *   PORT / AUREUS_HOST            Render sets PORT; host defaults to 0.0.0.0 on Render, 127.0.0.1 locally
 *   AUREUS_DATA_DIR               mount a persistent disk here (e.g. /var/data)
 *   AUREUS_AUTORUN_MINUTES        run a cycle every N minutes (unset = no autonomous loop)
 *   AUREUS_ANCHOR_EVERY_HOURS     publish a Merkle anchor this often if there are new private decisions (default 24)
 *   AUREUS_SEED_B64               one-time import of an existing journal (see `export-state`)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import * as guard from "./guard.ts";
import * as journal from "./journal.ts";
import { merkleRoot, sha256Hex } from "./crypto.ts";
import { wallet } from "./wallet.ts";
import { listTokens, resolveAssets } from "./intents.ts";
import * as confidential from "./confidential.ts";
import { runCycle } from "./cycle.ts";

const env = process.env;
const ON_HOST = Boolean(env.RENDER || env.PORT);
const PORT = Number(env.PORT ?? env.AUREUS_PORT ?? 8787);
const HOST = env.AUREUS_HOST ?? (ON_HOST ? "0.0.0.0" : "127.0.0.1");
const ORIGINS = (env.AUREUS_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TOKEN = env.AUREUS_DASHBOARD_TOKEN || (ON_HOST ? "" : randomBytes(24).toString("hex"));
if (!TOKEN || TOKEN.length < 24) throw new Error("set AUREUS_DASHBOARD_TOKEN (at least 24 characters, e.g. openssl rand -hex 24)");

function authorised(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const dataFile = (name: string) => join(config.dataDir, name);
const readOr = <T>(name: string, fallback: T): T =>
  existsSync(dataFile(name)) ? (JSON.parse(readFileSync(dataFile(name), "utf8")) as T) : fallback;

// ---------------------------------------------------------- one-time seed

/** Restore files exported with `export-state` into an empty data dir. Never overwrites. */
function seed() {
  if (!env.AUREUS_SEED_B64) return;
  const bundle = JSON.parse(Buffer.from(env.AUREUS_SEED_B64, "base64").toString("utf8")) as Record<string, string>;
  mkdirSync(config.dataDir, { recursive: true });
  for (const [name, content] of Object.entries(bundle)) {
    if (name.includes("/") || name.includes("..") || name === "session.json") continue;
    if (!existsSync(dataFile(name))) {
      writeFileSync(dataFile(name), content);
      console.log(`[seed] restored ${name}`);
    }
  }
}

// ------------------------------------------------------------------ handlers

async function status() {
  const g = guard.status();
  const assets = resolveAssets(config.universe, await listTokens());
  const priv = config.custody === "confidential" && config.mode === "live" ? await confidential.balances() : null;
  const rows = [];
  for (const a of assets) {
    const units = priv ? priv.get(a.assetId) ?? 0n : await wallet().balance(a.contract);
    const amount = Number(units) / 10 ** a.decimals;
    if (amount > 0) rows.push({ symbol: a.symbol, amount, usd: +(amount * a.price).toFixed(2) });
  }
  const navUsd = rows.reduce((s, r) => s + r.usd, 0);
  const holdings = rows.map((r) => ({ ...r, weight: navUsd ? +(r.usd / navUsd).toFixed(4) : 0 }));

  // Public footprint: what an explorer shows. Trades in wallet custody, anchors, plus
  // any setup/fund transactions listed in public.json.
  const publicTxs = [
    ...readOr<{ kind: string; txHash: string; at: string; label: string }[]>("public.json", []),
    ...journal.entries().filter((e) => e.kind !== "intent").map((e) => ({ kind: "trade", txHash: e.txHash, at: e.at, label: `trade #${e.n} (memo: commitment only)` })),
    ...journal.anchors().map((a) => ({ kind: "anchor", txHash: a.txHash, at: a.at, label: `anchor: root of ${a.leaves.length} decision(s)` })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    wallet: config.near.walletId,
    custody: config.custody,
    mode: config.mode,
    execute: config.execute,
    autorunMinutes: AUTORUN_MIN || null,
    lastAutorun,
    cycleRunning: busy,
    nextCycleAt: nextTickAt,
    navUsd: +navUsd.toFixed(2),
    drawdownPct: g.drawdownPct,
    maxDrawdownPct: config.limits.maxDrawdownPct,
    spentTodayUsd: g.spentTodayUsd,
    maxDailyUsd: config.limits.maxDailyUsd,
    maxTradeUsd: config.limits.maxTradeUsd,
    paused: g.paused,
    pauseReason: g.pauseReason,
    holdings,
    publicTxs,
    mandate: config.mandate,
    limits: { ...config.limits, custody: config.custody },
    updatedAt: new Date().toISOString(),
  };
}

function trades() {
  return journal.entries().map((e) => ({
    n: e.n,
    at: e.at,
    kind: e.kind ?? "tx",
    ref: e.txHash,
    commitment: e.commitment,
    anchorTx: e.kind === "intent" ? journal.anchorFor(e.commitment)?.txHash ?? null : null,
  }));
}

function readJsonl(name: string): any[] {
  if (!existsSync(dataFile(name))) return [];
  return readFileSync(dataFile(name), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Past cycles, newest first. */
function cycles(limit: number) {
  return readJsonl("cycles.jsonl").reverse().slice(0, limit);
}

/** NAV over time, oldest first, for the chart. */
function navSeries() {
  return readJsonl("cycles.jsonl").filter((c) => typeof c.navUsd === "number").map((c) => ({ at: c.at, navUsd: c.navUsd, drawdownPct: c.drawdownPct }));
}

/** Price history recorded by the scout each cycle: [{ at, prices: { SYMBOL: usd } }]. */
function prices(limit: number) {
  const all = readOr<{ at: string; prices: Record<string, number> }[]>("prices.json", []);
  return all.slice(-limit);
}

function anchors() {
  return journal.anchors().map((a) => ({ at: a.at, txHash: a.txHash, root: a.root, count: a.leaves.length }));
}

async function disclose(n: string) {
  const opened = journal.open(n);
  if (!opened) return null;
  const memoHash = sha256Hex(opened.memo);
  const kind = opened.entry.kind ?? "tx";
  let anchor = null;
  let onchainCommitment: string | null = null;
  let match = false;
  if (kind === "intent") {
    const a = journal.anchorFor(opened.entry.commitment);
    if (a) {
      const onchainRoot = await wallet().anchorOf(a.txHash).catch(() => null);
      anchor = { txHash: a.txHash, root: a.root, onchainRoot, leafIndex: a.leaves.indexOf(memoHash), count: a.leaves.length };
      match = memoHash === opened.entry.commitment && a.leaves.includes(memoHash) && merkleRoot(a.leaves) === a.root && onchainRoot === a.root;
    }
  } else {
    onchainCommitment = await wallet().commitmentOf(opened.entry.txHash).catch(() => null);
    match = onchainCommitment === memoHash;
  }
  return { memo: JSON.parse(opened.memo), memoHash, commitment: opened.entry.commitment, kind, anchor, onchainCommitment, match };
}

async function attestation() {
  if (config.mode !== "live") return { model: "mock", signingAddress: "", tdx: false, nvidia: false, nonceFresh: false, reportSha256: "" };
  const { attestationReport } = await import("./nearai.ts");
  const { canonical } = await import("./crypto.ts");
  const { nonce, report } = await attestationReport();
  const text = JSON.stringify(report);
  return {
    model: config.nearAi.model,
    signingAddress: text.match(/"signing_address"\s*:\s*"(0x[0-9a-fA-F]{40})"/)?.[1] ?? "",
    tdx: /intel_quote|tdx/i.test(text),
    nvidia: /nvidia_payload/i.test(text),
    nonceFresh: text.includes(nonce),
    reportSha256: sha256Hex(canonical(report)),
  };
}

// One cycle at a time, whether started by the loop or the dashboard.
let busy = false;
async function cycle(dryRun: boolean) {
  if (busy) return { ok: false, message: "a cycle is already running" };
  busy = true;
  try {
    const r = await runCycle((s) => console.log(s), { dryRun });
    if (r.halted) return { ok: true, message: `halted: ${r.halted}` };
    const counts: Record<string, number> = {};
    for (const x of r.results ?? []) counts[x.status] = (counts[x.status] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    return { ok: true, message: `cycle done: ${summary || "no trades"}` };
  } finally {
    busy = false;
  }
}

async function anchorNow() {
  const pending = journal.unanchored();
  if (!pending.length) return { ok: true, message: "nothing to anchor" };
  const leaves = pending.map((e) => e.commitment);
  const root = merkleRoot(leaves);
  const { txHash } = await wallet().anchor(root, leaves.length);
  journal.recordAnchor({ at: new Date().toISOString(), txHash, root, leaves });
  return { ok: true, message: `anchored ${leaves.length} decision(s) in tx ${txHash}` };
}

// ------------------------------------------------------------ autonomous loop

const AUTORUN_MIN = Number(env.AUREUS_AUTORUN_MINUTES ?? 0);
const ANCHOR_HOURS = Number(env.AUREUS_ANCHOR_EVERY_HOURS ?? 24);
let lastAutorun: { at: string; message: string } | null = null;
let nextTickAt: string | null = null;

function startLoop() {
  if (!AUTORUN_MIN) return;
  const tick = async () => {
    nextTickAt = new Date(Date.now() + AUTORUN_MIN * 60_000).toISOString();
    try {
      const out = await cycle(false);
      lastAutorun = { at: new Date().toISOString(), message: out.message };
      const last = journal.anchors().at(-1);
      const due = !last || Date.now() - Date.parse(last.at) > ANCHOR_HOURS * 3_600_000;
      if (due && journal.unanchored().length) console.log(`[anchor] ${(await anchorNow()).message}`);
    } catch (e) {
      lastAutorun = { at: new Date().toISOString(), message: `error: ${(e as Error).message}` };
      console.error(`[loop] ${(e as Error).message}`);
    }
  };
  nextTickAt = new Date(Date.now() + 15_000).toISOString();
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), AUTORUN_MIN * 60_000);
  }, 15_000);
  console.log(`[loop] autonomous cycle every ${AUTORUN_MIN} min, ${config.execute ? "LIVE EXECUTION" : "dry (quotes only)"}, anchor every ${ANCHOR_HOURS} h`);
}

// ------------------------------------------------------------------- routing

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (m === "GET" && (p === "/api/health" || p === "/")) return send(res, 200, { ok: true, service: "aureus" });
  if (!authorised(req)) return send(res, 401, { error: "missing or wrong token" });

  if (m === "GET" && p === "/api/status") return send(res, 200, await status());
  if (m === "GET" && p === "/api/cycle/last") return send(res, 200, readOr("last-cycle.json", null));
  if (m === "GET" && p === "/api/trades") return send(res, 200, trades());
  if (m === "GET" && p === "/api/anchors") return send(res, 200, anchors());
  if (m === "GET" && p === "/api/cycles") return send(res, 200, cycles(Math.min(200, Number(url.searchParams.get("limit") ?? 50))));
  if (m === "GET" && p === "/api/nav") return send(res, 200, navSeries());
  if (m === "GET" && p === "/api/prices") return send(res, 200, prices(Math.min(500, Number(url.searchParams.get("limit") ?? 200))));
  if (m === "GET" && p === "/api/attestation") return send(res, 200, await attestation());
  const d = p.match(/^\/api\/disclose\/(\d+)$/);
  if (m === "POST" && d) {
    const out = await disclose(d[1]);
    return out ? send(res, 200, out) : send(res, 404, { error: "no such decision" });
  }
  if (m === "POST" && p === "/api/cycle") return send(res, 200, await cycle(true)); // always dry
  if (m === "POST" && p === "/api/pause") {
    const body = await readJson(req);
    guard.pause(typeof body.reason === "string" && body.reason ? body.reason : "paused from dashboard");
    return send(res, 200, { ok: true, message: "agent paused" });
  }
  if (m === "POST" && p === "/api/resume") { guard.resume(); return send(res, 200, { ok: true, message: "agent resumed" }); }
  if (m === "POST" && p === "/api/anchor") return send(res, 200, await anchorNow());
  return send(res, 404, { error: "not found" });
}

/** "https://*.lovable.app" matches any subdomain; everything else must match exactly. */
function originMatches(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) return pattern === origin;
  const re = new RegExp("^" + pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+") + "$", "i");
  return re.test(origin);
}

export function start() {
  seed();
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = !origin ? true : ORIGINS.length === 0 ? !ON_HOST : ORIGINS.some((o) => originMatches(o, origin));
    if (origin && allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (req.method === "OPTIONS") { res.writeHead(allowed ? 204 : 403); res.end(); return; }
    if (origin && !allowed) return send(res, 403, { error: `origin ${origin} not allowed (set AUREUS_ALLOWED_ORIGINS)` });
    try {
      await route(req, res);
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`AUREUS API on http://${HOST}:${PORT}  mode=${config.mode} custody=${config.custody}`);
    console.log(ORIGINS.length ? `allowed origins: ${ORIGINS.join(", ")}` : ON_HOST ? "WARNING: no AUREUS_ALLOWED_ORIGINS set, browsers are blocked" : "local: any browser origin allowed");
    if (!env.AUREUS_DASHBOARD_TOKEN) console.log(`token: ${TOKEN}`);
    startLoop();
  });
}
