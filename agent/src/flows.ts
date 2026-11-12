/**
 * Owner deposits into and withdrawals from the managed book.
 * NAV moves for two reasons: the agent's trading, and the owner adding or removing money.
 * Only the first is performance, so every flow is recorded here and P&L leaves it out.
 * usd > 0 = money in, usd < 0 = money out.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export interface Flow { at: string; usd: number; note: string }

const file = () => join(config.dataDir, "flows.jsonl");

export function all(): Flow[] {
  if (!existsSync(file())) return [];
  return readFileSync(file(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Flow);
}

export function record(f: Flow) {
  mkdirSync(config.dataDir, { recursive: true });
  appendFileSync(file(), JSON.stringify(f) + "\n");
}

/** Net money the owner added after `from` and up to `to` (ISO times). */
export function netBetween(from: string, to: string): number {
  return all().filter((f) => f.at > from && f.at <= to).reduce((s, f) => s + f.usd, 0);
}

/** Performance against what the owner put in. Baseline = NAV at the first cycle, moved by every later flow. */
export function pnl(series: { at: string; navUsd: number }[], navNow: number) {
  if (!series.length) return null;
  const first = series[0];
  const now = new Date().toISOString();
  const net = netBetween(first.at, now);
  const investedUsd = first.navUsd + net;
  const pnlUsd = navNow - investedUsd;
  return {
    since: first.at,
    startNavUsd: +first.navUsd.toFixed(2),
    netDepositsUsd: +net.toFixed(2),
    investedUsd: +investedUsd.toFixed(2),
    pnlUsd: +pnlUsd.toFixed(2),
    pnlPct: investedUsd > 0 ? +((pnlUsd / investedUsd) * 100).toFixed(2) : 0,
  };
}

/** Tell the hosted agent about a flow made from this machine (fund / withdraw on a laptop). */
export async function reportToAgent(f: Flow): Promise<string> {
  const url = process.env.AUREUS_API_URL;
  const token = process.env.AUREUS_DASHBOARD_TOKEN;
  if (!url || !token) return "not reported to the hosted agent (set AUREUS_API_URL and AUREUS_DASHBOARD_TOKEN in .env)";
  const res = await fetch(`${url.replace(/\/$/, "")}/api/flow`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(f),
  });
  return res.ok ? `recorded on ${new URL(url).host}` : `hosted agent refused it: ${res.status} ${await res.text()}`;
}
