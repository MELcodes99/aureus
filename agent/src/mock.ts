/**
 * Offline mode so anyone can run the full loop without keys or funds.
 * Market data moves between cycles; AUREUS_SCENARIO=crash simulates a selloff
 * that should trip the guard's drawdown kill switch.
 * The mock "LLM" is a transparent rules engine standing in for the enclave model.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.ts";
import type { IntentsToken, Quote } from "./intents.ts";

function cycleNumber(): number {
  const f = join(config.dataDir, "prices.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as unknown[]).length : 0;
}

// A deterministic walk: NEAR trends up early, ETH chops, BTC drifts.
const WALK: Record<string, number[]> = {
  wNEAR: [1, 1.03, 1.06, 1.04, 1.09, 1.12, 1.08, 1.13],
  ETH: [1, 0.99, 1.01, 0.98, 1.0, 1.02, 0.99, 1.01],
  BTC: [1, 1.01, 1.02, 1.02, 1.03, 1.04, 1.03, 1.05],
};
const CRASH: Record<string, number> = { wNEAR: 0.6, ETH: 0.65, BTC: 0.7 };

export function mockTokens(): IntentsToken[] {
  const base = JSON.parse(readFileSync(new URL("../fixtures/tokens.json", import.meta.url), "utf8")) as IntentsToken[];
  const n = cycleNumber();
  const crash = process.env.AUREUS_SCENARIO === "crash";
  return base.map((t) => {
    const walk = WALK[t.symbol];
    let mult = walk ? walk[n % walk.length] : 1;
    if (crash && CRASH[t.symbol]) mult *= CRASH[t.symbol];
    return { ...t, price: +(t.price * mult).toFixed(6) };
  });
}

export function mockQuote(
  from: { decimals: number; price: number; symbol: string },
  to: { decimals: number; price: number; symbol: string },
  amount: bigint,
  dry: boolean,
): Quote {
  const usdIn = (Number(amount) / 10 ** from.decimals) * from.price;
  const outUnits = (usdIn * 0.997) / to.price;
  const out = BigInt(Math.floor(outUnits * 10 ** Math.min(to.decimals, 15))) * 10n ** BigInt(Math.max(0, to.decimals - 15));
  const min = (out * 99n) / 100n;
  return {
    depositAddress: dry ? undefined : createHash("sha256").update(`${from.symbol}${to.symbol}${amount}${Date.now()}`).digest("hex"),
    amountIn: amount.toString(),
    amountInUsd: usdIn.toFixed(2),
    amountOut: out.toString(),
    amountOutFormatted: outUnits.toFixed(6),
    amountOutUsd: (usdIn * 0.997).toFixed(2),
    minAmountOut: min.toString(),
    timeEstimate: 20,
  };
}

type W = Record<string, number>;
const norm = (w: W): W => {
  const s = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, +(v / s).toFixed(4)]));
};

export function mockLlm(role: string, input: any): unknown {
  if (role === "strategist") {
    const { mandate, market } = input;
    const stables = market.filter((a: any) => a.stable);
    const risky = market.filter((a: any) => !a.stable);
    const tilt = { conservative: 0.15, balanced: 0, aggressive: -0.1 }[mandate.riskProfile as string] ?? 0;
    const bearish = risky.every((a: any) => (a.momentumPct ?? 0) < 0);
    const stableW = Math.min(0.9, Math.max(mandate.minStableWeight + tilt, bearish ? 0.6 : mandate.minStableWeight));
    const scores = risky.map((a: any) => Math.max(0.05, 1 + (a.momentumPct ?? 0) / 5 - (a.volatilityPct ?? 0) / 20));
    const total = scores.reduce((a: number, b: number) => a + b, 0) || 1;
    const w: W = {};
    // Keep the stable cushion in whichever stable is already held: stable-to-stable swaps are pure cost.
    const held = (sym: string) => input.holdings?.find((h: any) => h.symbol === sym)?.usd ?? 0;
    const home = [...stables].sort((a: any, b: any) => held(b.symbol) - held(a.symbol))[0];
    stables.forEach((a: any) => (w[a.symbol] = a === home ? stableW : 0));
    risky.forEach((a: any, i: number) => (w[a.symbol] = ((1 - stableW) * scores[i]) / total));
    const leader = [...risky].sort((a: any, b: any) => (b.momentumPct ?? 0) - (a.momentumPct ?? 0))[0];
    return {
      targetWeights: norm(w),
      thesis: risky.every((a: any) => a.momentumPct === null)
        ? `No price history yet. Spread the risk budget evenly and keep a ${Math.round(stableW * 100)}% stable floor.`
        : bearish
        ? "Every risk asset has negative momentum. Raise the stablecoin cushion and wait."
        : `Momentum favours ${leader?.symbol}. Tilt risk budget toward it, keep the ${Math.round(stableW * 100)}% stable floor.`,
      confidence: bearish ? 0.7 : 0.6,
      signals: risky.map((a: any) => `${a.symbol} momentum ${(a.momentumPct ?? 0).toFixed(1)}%`),
    };
  }
  if (role === "risk") {
    const { mandate, proposal, guard } = input;
    const w: W = { ...proposal.targetWeights };
    const concerns: string[] = [];
    const stress = guard.drawdownPct > guard.maxDrawdownPct / 2;
    if (stress) {
      concerns.push(`Drawdown ${guard.drawdownPct}% is over half the ${guard.maxDrawdownPct}% kill switch. De-risking.`);
      for (const [k, v] of Object.entries(w)) if (!input.stableSymbols.includes(k)) w[k] = v / 2;
    }
    for (const [k, v] of Object.entries(w)) {
      if (!input.stableSymbols.includes(k) && v > mandate.maxSingleAssetWeight) {
        concerns.push(`${k} at ${(v * 100).toFixed(0)}% breaches the ${mandate.maxSingleAssetWeight * 100}% single-asset cap.`);
        w[k] = mandate.maxSingleAssetWeight;
      }
    }
    if (proposal.confidence < 0.4) concerns.push("Strategist confidence is low; trading smaller.");
    return { approve: true, adjustedWeights: norm(w), concerns, sizeMultiplier: proposal.confidence < 0.4 ? 0.5 : 1 };
  }
  throw new Error(`no mock for role ${role}`);
}
