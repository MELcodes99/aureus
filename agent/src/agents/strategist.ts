/**
 * Strategist: proposes target weights. Runs ONLY inside a NEAR AI Cloud TEE.
 * Its prompt contains the owner's mandate and full book, which is exactly the
 * information a public chain or a normal AI API would leak.
 */
import { z } from "zod";
import { config } from "../config.ts";
import { privateJson } from "../nearai.ts";
import type { Snapshot } from "./scout.ts";

export const Proposal = z.object({
  targetWeights: z.record(z.string(), z.number().min(0).max(1)),
  thesis: z.string().min(1),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()).default([]),
  /** One plain sentence per asset saying why it gets its weight. Shown next to each trade. */
  notes: z.record(z.string(), z.string()).default({}),
});
export type Proposal = z.infer<typeof Proposal>;

const SYSTEM = `You are the Strategist in AUREUS, a private autonomous portfolio manager on NEAR.
Given the owner's mandate, market data and current holdings, propose target portfolio weights.

Market data per asset:
- context.change24hPct / change7dPct / change30dPct: multi-day trend from public market data
- context.range24hPct: today's high-low range as % of price (a daily volatility gauge)
- momentumPct / volatilityPct: the agent's own samples over the last few cycles (short-term noise)
Any field may be null; never invent a number that is null.

How to decide:
1. Trend: favour risk assets whose 7d and 30d trends agree and are positive; cut ones where both are negative.
   A 24h move against a clear 7d/30d trend is usually noise.
2. Volatility: size inversely to range24hPct. A wild asset gets less weight than a calm one with the same trend.
3. Regime: if most risk assets trend down on 7d and 30d, raise stables above the minimum. If most trend up, stay near it.
4. Churn: trades cost spread and fees. Keep a current weight unless the case to move it is clear,
   or the book breaks the mandate. Do not move a target by less than rebalanceThreshold without a reason.
5. Stables: keep the stable share in stables already held unless diversifying depeg risk is worth a swap.

Rules: weights are fractions that sum to 1; only use symbols from the market list.
maxSingleAssetWeight caps each NON-stable asset only. Stablecoins are exempt from it: USDC at 40% is fine.
minStableWeight is a floor on all stablecoins combined. Never trade one stablecoin for another to meet a cap.
Return {"targetWeights":{SYMBOL:number},"thesis":string,"confidence":0..1,"signals":[string],
"notes":{SYMBOL:string}}. thesis: 2-4 sentences citing the numbers that drove the decision.
notes: one short plain-English sentence per symbol explaining its weight, citing a number where possible.`;

export async function strategist(snap: Snapshot) {
  return privateJson("strategist", SYSTEM, {
    mandate: config.mandate,
    market: snap.market,
    holdings: snap.holdings.map((h) => ({ symbol: h.asset.symbol, usd: +h.usd.toFixed(2), weight: +h.weight.toFixed(4) })),
    navUsd: +snap.navUsd.toFixed(2),
  }, Proposal);
}
