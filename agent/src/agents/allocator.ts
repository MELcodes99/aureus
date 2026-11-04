/**
 * Allocator: turns target weights into concrete swaps, sized to fit the guard's
 * limits (per-trade USD cap and what is left of today's USD budget).
 */
import { config } from "../config.ts";
import type { ResolvedAsset } from "../intents.ts";
import { toUnits, type Snapshot } from "./scout.ts";

export interface PlannedTrade {
  from: ResolvedAsset;
  to: ResolvedAsset;
  usd: number;
  amount: bigint;
  reason: string;
  clippedBy?: string;
}

export function allocate(
  snap: Snapshot,
  target: Record<string, number>,
  sizeMultiplier: number,
  budget: { maxTradeUsd: number; remainingTodayUsd: number },
): { trades: PlannedTrade[]; skipped: string[] } {
  const m = config.mandate;
  const skipped: string[] = [];
  const sells: { a: ResolvedAsset; usd: number; units: bigint }[] = [];
  const buys: { a: ResolvedAsset; usd: number }[] = [];
  let remaining = budget.remainingTodayUsd;

  for (const h of snap.holdings) {
    const drift = (target[h.asset.symbol] ?? 0) - h.weight;
    if (Math.abs(drift) < m.rebalanceThreshold) continue;
    const usd = Math.abs(drift) * snap.navUsd;
    if (drift < 0) sells.push({ a: h.asset, usd, units: h.units });
    else buys.push({ a: h.asset, usd });
  }
  sells.sort((x, y) => y.usd - x.usd);
  buys.sort((x, y) => y.usd - x.usd);

  const trades: PlannedTrade[] = [];
  for (const b of buys) {
    for (const s of sells) {
      if (b.usd < m.minTradeUsd) break;
      if (s.usd < m.minTradeUsd) continue;
      let usd = Math.min(b.usd, s.usd) * sizeMultiplier;
      let clippedBy: string | undefined;
      if (usd > budget.maxTradeUsd) { usd = budget.maxTradeUsd; clippedBy = "per-trade cap"; }
      if (usd > remaining) { usd = remaining; clippedBy = "daily cap"; }
      let amount = toUnits(usd / s.a.price, s.a.decimals);
      if (amount > s.units) { amount = s.units; usd = (Number(amount) / 10 ** s.a.decimals) * s.a.price; }
      if (usd < m.minTradeUsd) {
        skipped.push(`${s.a.symbol}->${b.a.symbol} $${usd.toFixed(2)} below minimum${clippedBy ? ` after ${clippedBy}` : ""}`);
        continue;
      }
      trades.push({ from: s.a, to: b.a, usd, amount, clippedBy, reason: `${s.a.symbol} overweight, ${b.a.symbol} underweight` });
      remaining -= usd;
      s.units -= amount;
      s.usd -= usd / sizeMultiplier;
      b.usd -= usd / sizeMultiplier;
    }
  }
  return { trades, skipped };
}
