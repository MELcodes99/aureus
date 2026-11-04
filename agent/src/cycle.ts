/**
 * One AUREUS cycle: Scout -> Guard (drawdown) -> Strategist -> Risk -> Allocator -> Executor.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import * as guard from "./guard.ts";
import { scout, type Snapshot } from "./agents/scout.ts";
import { strategist } from "./agents/strategist.ts";
import { risk } from "./agents/risk.ts";
import { allocate } from "./agents/allocator.ts";
import { execute, type ExecutionResult } from "./agents/executor.ts";
import type { InferenceProof } from "./nearai.ts";

export interface CycleReport {
  cycleId: string;
  at: string;
  mode: string;
  sendsMoney: boolean;
  halted?: string;
  navUsd?: number;
  drawdownPct?: number;
  market?: Snapshot["market"];
  holdings?: { symbol: string; usd: number; weight: number }[];
  thesis?: string;
  confidence?: number;
  concerns?: string[];
  targetWeights?: Record<string, number>;
  skipped?: string[];
  results?: Array<Omit<ExecutionResult, "trade"> & { from: string; to: string; usd: number; clippedBy?: string }>;
  proofs?: InferenceProof[];
}

export async function runCycle(log: (s: string) => void = console.log): Promise<CycleReport> {
  const cycleId = randomUUID();
  const report: CycleReport = { cycleId, at: new Date().toISOString(), mode: config.mode, sendsMoney: config.mode === "mock" || config.execute };
  const done = (r: CycleReport) => {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(join(config.dataDir, "last-cycle.json"), JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return r;
  };

  let g = guard.status();
  if (g.paused) {
    log(`[guard] paused: ${g.pauseReason}. Run \`resume\` to let the agent trade again.`);
    return done({ ...report, halted: `paused: ${g.pauseReason}` });
  }

  log(`[scout] reading 1Click prices and ${config.custody === "confidential" ? "private Confidential Intents balances" : "wallet balances"}`);
  const snap = await scout();
  report.navUsd = +snap.navUsd.toFixed(2);
  report.market = snap.market;
  report.holdings = snap.holdings.map((h) => ({ symbol: h.asset.symbol, usd: +h.usd.toFixed(2), weight: +h.weight.toFixed(4) }));
  log(`[scout] NAV $${report.navUsd}  ${report.holdings.map((h) => `${h.symbol} ${(h.weight * 100).toFixed(1)}%`).join("  ")}`);
  if (snap.navUsd <= 0) {
    log(config.custody === "confidential"
      ? "[scout] confidential balance is empty. Move funds in with `fund <SYMBOL> <amount>`."
      : "[scout] wallet has nothing tradable above the gas reserve. Fund it and run again.");
    return done({ ...report, halted: "empty wallet" });
  }

  g = guard.recordNav(snap.navUsd);
  report.drawdownPct = g.drawdownPct;
  if (g.paused) {
    log(`[guard] KILL SWITCH: ${g.pauseReason}. Agent stopped until you run \`resume\`.`);
    return done({ ...report, halted: `kill switch: ${g.pauseReason}` });
  }

  log(`[strategist] ${config.mode === "mock" ? "simulated model (mock mode, no TEE)" : `private inference in NEAR AI Cloud TEE (${config.nearAi.model})`}`);
  const s = await strategist(snap);
  log(`[strategist] ${s.data.thesis} (confidence ${s.data.confidence})`);

  log(`[risk] ${config.mode === "mock" ? "simulated review" : "private review in TEE"} + mandate guard`);
  const r = await risk(snap, s.data, g);
  r.review.concerns.forEach((c) => log(`[risk] ${c}`));
  const proofs = [s.proof, r.proof];
  Object.assign(report, { thesis: s.data.thesis, confidence: s.data.confidence, concerns: r.review.concerns, targetWeights: r.finalWeights, proofs });
  if (!r.review.approve) {
    log("[risk] vetoed this cycle");
    return done({ ...report, halted: "risk veto" });
  }

  let { trades, skipped } = allocate(snap, r.finalWeights, r.review.sizeMultiplier, {
    maxTradeUsd: config.limits.maxTradeUsd,
    remainingTodayUsd: g.remainingTodayUsd,
  });
  if (config.limits.cooldownMinutes > 0 && trades.length > 1) {
    skipped.push(`${trades.length - 1} trade(s) deferred: ${config.limits.cooldownMinutes} min cooldown allows one per cycle`);
    trades = trades.slice(0, 1);
  }
  report.skipped = skipped;
  skipped.forEach((x) => log(`[allocator] skip: ${x}`));
  if (!trades.length) log(skipped.length ? "[allocator] no trades this cycle" : "[allocator] book is within tolerance; no trades");

  report.results = [];
  for (const t of trades) {
    log(`[executor] ${t.from.symbol} -> ${t.to.symbol} $${t.usd.toFixed(2)}${t.clippedBy ? ` (clipped by ${t.clippedBy})` : ""}, confidential route`);
    const res = await execute(t, { cycleId, thesis: s.data.thesis, riskConcerns: r.review.concerns, proofs });
    const { trade, ...rest } = res;
    report.results.push({ ...rest, from: trade.from.symbol, to: trade.to.symbol, usd: +trade.usd.toFixed(2), clippedBy: trade.clippedBy });
    if (res.status === "executed" && config.custody === "confidential") log(`[executor] private intent ${res.txHash} swap ${res.swapStatus}; nothing published onchain. commitment ${res.commitment?.slice(0, 16)}... kept in your journal`);
    else if (res.status === "executed") log(`[executor] tx ${res.txHash} swap ${res.swapStatus}; onchain memo aureus:${res.commitment?.slice(0, 16)}...`);
    else if (res.status === "previewed") log(`[executor] dry quote: ~${res.quote?.amountOutFormatted} ${t.to.symbol} (set AUREUS_EXECUTE=true to trade)`);
    else log(`[executor] ${res.status}: ${res.error}`);
  }
  return done(report);
}
