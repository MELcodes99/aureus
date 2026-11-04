/**
 * Risk officer: two layers.
 *  1. LLM review inside the TEE (can only make the book safer: shrink, de-risk, veto).
 *  2. Deterministic guard that always runs last and cannot be talked out of the mandate.
 * The guard (src/guard.ts) then enforces USD caps, cooldown and the drawdown stop.
 */
import { z } from "zod";
import { config } from "../config.ts";
import { privateJson } from "../nearai.ts";
import type * as guard from "../guard.ts";
import type { Proposal } from "./strategist.ts";
import type { Snapshot } from "./scout.ts";

export const Review = z.object({
  approve: z.boolean(),
  adjustedWeights: z.record(z.string(), z.number().min(0).max(1)),
  concerns: z.array(z.string()).default([]),
  sizeMultiplier: z.number().min(0).max(1).default(1),
});
export type Review = z.infer<typeof Review>;

const SYSTEM = `You are the Risk Officer in AUREUS. Review the Strategist's proposal against the mandate,
the portfolio's drawdown and market volatility. You may only reduce risk: lower risky weights, raise stables,
shrink size (sizeMultiplier 0..1) or reject (approve=false). Never increase risk.
Return {"approve":bool,"adjustedWeights":{SYMBOL:number},"concerns":[string],"sizeMultiplier":0..1}.`;

/** Clamp to mandate. Excess from capped assets flows to stables. Pure function, unit-tested. */
export function enforceMandate(weights: Record<string, number>, symbols: string[], stables: string[]) {
  const m = config.mandate;
  const w: Record<string, number> = {};
  for (const s of symbols) w[s] = Math.max(0, weights[s] ?? 0);
  let total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total <= 0) for (const s of stables) w[s] = 1 / stables.length;
  else for (const s of symbols) w[s] /= total;

  const toStables = (amt: number) => stables.forEach((s) => (w[s] += amt / stables.length));
  for (const s of symbols) {
    if (!stables.includes(s) && w[s] > m.maxSingleAssetWeight) {
      toStables(w[s] - m.maxSingleAssetWeight);
      w[s] = m.maxSingleAssetWeight;
    }
  }
  const stableNow = stables.reduce((a, s) => a + w[s], 0);
  if (stableNow < m.minStableWeight) {
    const need = m.minStableWeight - stableNow;
    const riskyTotal = 1 - stableNow;
    for (const s of symbols) if (!stables.includes(s)) w[s] -= riskyTotal ? (w[s] / riskyTotal) * need : 0;
    toStables(need);
  }
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, +v.toFixed(6)]));
}

export async function risk(snap: Snapshot, proposal: Proposal, g: ReturnType<typeof guard.status>) {
  const symbols = snap.assets.map((a) => a.symbol);
  const stables = snap.assets.filter((a) => a.stable).map((a) => a.symbol);
  const { data, proof } = await privateJson("risk", SYSTEM, {
    mandate: config.mandate,
    proposal,
    market: snap.market,
    stableSymbols: stables,
    // Strings with "%" so the model cannot misread 0.04 (percent) as 4%.
    guard: { drawdownFromPeak: `${g.drawdownPct}%`, killSwitchAt: `${g.limits.maxDrawdownPct}%`, paused: g.paused },
  }, Review);

  // The LLM may only reduce risk: never accept a risky weight above what the strategist proposed.
  const merged: Record<string, number> = {};
  for (const s of symbols) {
    const p = proposal.targetWeights[s] ?? 0;
    const r = data.adjustedWeights[s] ?? p;
    merged[s] = stables.includes(s) ? Math.max(p, r) : Math.min(p, r);
  }
  const finalWeights = enforceMandate(merged, symbols, stables);
  return { review: data, finalWeights, proof };
}
