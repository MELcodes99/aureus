/**
 * Guard: the owner's hard limits, enforced in code before every trade.
 * Deterministic. No LLM can change these numbers; only aureus.config.json can.
 *
 * - max USD per trade and per UTC day
 * - cooldown between trades
 * - drawdown kill switch: once tripped, nothing trades until the owner runs `resume`
 *
 * The onchain kill switch that nobody can override is deleting the agent's key
 * from the wallet (`revoke`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

interface GuardState {
  hwmUsd: number;
  lastNavUsd: number;
  paused: boolean;
  pauseReason: string | null;
  day: number;
  spentUsd: number;
  lastTradeMs: number;
  /** Which book the NAV was measured on. A change of custody starts a fresh baseline. */
  custody?: string;
}

const DAY_MS = 86_400_000;
const file = () => join(config.dataDir, "guard.json");
const fresh = (): GuardState => ({ hwmUsd: 0, lastNavUsd: 0, paused: false, pauseReason: null, day: 0, spentUsd: 0, lastTradeMs: 0 });

function load(): GuardState {
  return existsSync(file()) ? { ...fresh(), ...JSON.parse(readFileSync(file(), "utf8")) } : fresh();
}
function save(s: GuardState) {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
}
const today = () => Math.floor(Date.now() / DAY_MS);

export function status() {
  const s = load();
  const dd = s.hwmUsd > 0 && s.lastNavUsd < s.hwmUsd ? ((s.hwmUsd - s.lastNavUsd) / s.hwmUsd) * 100 : 0;
  const spent = s.day === today() ? s.spentUsd : 0;
  return {
    ...s,
    drawdownPct: +dd.toFixed(2),
    spentTodayUsd: +spent.toFixed(2),
    remainingTodayUsd: +Math.max(0, config.limits.maxDailyUsd - spent).toFixed(2),
    limits: config.limits,
  };
}

/** Update NAV and trip the kill switch on excessive drawdown. */
export function recordNav(navUsd: number) {
  const s = load();
  if (s.custody !== config.custody) {
    // Switching between wallet and private custody changes what NAV measures; that is not a loss.
    s.custody = config.custody;
    s.hwmUsd = navUsd;
  }
  s.lastNavUsd = navUsd;
  if (navUsd > s.hwmUsd) s.hwmUsd = navUsd;
  const dd = s.hwmUsd > 0 ? ((s.hwmUsd - navUsd) / s.hwmUsd) * 100 : 0;
  if (!s.paused && dd > config.limits.maxDrawdownPct) {
    s.paused = true;
    s.pauseReason = `drawdown ${dd.toFixed(2)}% > limit ${config.limits.maxDrawdownPct}%`;
  }
  save(s);
  return status();
}

/** Throws with a human-readable reason if this trade breaks a limit. */
export function check(usd: number) {
  const s = load();
  const L = config.limits;
  if (s.paused) throw new Error(`guard: paused (${s.pauseReason})`);
  if (usd > L.maxTradeUsd + 1e-6) throw new Error(`guard: $${usd.toFixed(2)} over per-trade cap $${L.maxTradeUsd}`);
  const spent = s.day === today() ? s.spentUsd : 0;
  if (spent + usd > L.maxDailyUsd + 1e-6) throw new Error(`guard: over daily cap ($${spent.toFixed(2)} of $${L.maxDailyUsd} used)`);
  const wait = s.lastTradeMs + L.cooldownMinutes * 60_000 - Date.now();
  if (s.lastTradeMs && wait > 0) throw new Error(`guard: cooldown, ${Math.ceil(wait / 60_000)} min left`);
}

export function recordTrade(usd: number) {
  const s = load();
  if (s.day !== today()) { s.day = today(); s.spentUsd = 0; }
  s.spentUsd += usd;
  s.lastTradeMs = Date.now();
  save(s);
}

/** Owner action: unpause and measure drawdown from today's NAV. */
export function resume() {
  const s = load();
  s.paused = false;
  s.pauseReason = null;
  s.hwmUsd = s.lastNavUsd;
  save(s);
}

/**
 * Owner moved money into (+) or out of (-) the managed book (fund / withdraw).
 * Shift the baseline by the same amount so deposits and withdrawals never count as P&L.
 */
export function adjustForFlow(usd: number) {
  const s = load();
  s.hwmUsd = Math.max(0, s.hwmUsd + usd);
  s.lastNavUsd = Math.max(0, s.lastNavUsd + usd);
  save(s);
}

export function pause(reason: string) {
  const s = load();
  s.paused = true;
  s.pauseReason = reason;
  save(s);
}
