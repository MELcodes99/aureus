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
});
export type Proposal = z.infer<typeof Proposal>;

const SYSTEM = `You are the Strategist in AUREUS, a private autonomous portfolio manager on NEAR.
Given the owner's mandate, market data and current holdings, propose target portfolio weights.
Rules: weights are fractions that sum to 1; only use symbols from the market list;
respect minStableWeight and maxSingleAssetWeight; prefer doing nothing over churn.
Return {"targetWeights":{SYMBOL:number},"thesis":string,"confidence":0..1,"signals":[string]}.`;

export async function strategist(snap: Snapshot) {
  return privateJson("strategist", SYSTEM, {
    mandate: config.mandate,
    market: snap.market,
    holdings: snap.holdings.map((h) => ({ symbol: h.asset.symbol, usd: +h.usd.toFixed(2), weight: +h.weight.toFixed(4) })),
    navUsd: +snap.navUsd.toFixed(2),
  }, Proposal);
}
