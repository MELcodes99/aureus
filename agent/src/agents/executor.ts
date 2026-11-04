/**
 * Executor: the only agent that moves money.
 * 1. dry Confidential Intents quote (always)
 * 2. guard check against the owner's limits
 * 3. firm quote -> seal the private reasoning into a commitment
 * 4. one wallet transaction: wrap if needed + ft_transfer to the deposit address
 *    with memo "aureus:<commitment>"
 * 5. track the swap through NEAR's private shard until proceeds land back
 */
import { config } from "../config.ts";
import { canonical, newSalt, sha256Hex } from "../crypto.ts";
import * as guard from "../guard.ts";
import { requestQuote, submitDeposit, swapStatus, type Quote } from "../intents.ts";
import * as journal from "../journal.ts";
import type { InferenceProof } from "../nearai.ts";
import { wallet } from "../wallet.ts";
import { signAndSubmit } from "../confidential.ts";
import type { PlannedTrade } from "./allocator.ts";

export interface ExecutionResult {
  trade: PlannedTrade;
  quote?: Quote;
  status: "previewed" | "executed" | "blocked" | "failed";
  txHash?: string;
  commitment?: string;
  swapStatus?: string;
  error?: string;
}

export interface CycleContext {
  cycleId: string;
  thesis: string;
  riskConcerns: string[];
  proofs: InferenceProof[];
  /** Force quotes only for this run, whatever AUREUS_EXECUTE says (dashboard "Run dry cycle"). */
  dryRun?: boolean;
}

const sendsMoney = (ctx: CycleContext) => !ctx.dryRun && (config.mode === "mock" || config.execute);

async function waitForSwap(depositAddress: string): Promise<string> {
  const end = Date.now() + (config.mode === "mock" ? 0 : 180_000);
  let s = await swapStatus(depositAddress);
  while (!["SUCCESS", "FAILED", "REFUNDED"].includes(s) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 5_000));
    s = await swapStatus(depositAddress);
  }
  return s;
}

export async function execute(trade: PlannedTrade, ctx: CycleContext): Promise<ExecutionResult> {
  let preview;
  try {
    preview = await requestQuote({ from: trade.from, to: trade.to, amount: trade.amount, dry: true });
  } catch (e) {
    return { trade, status: "failed", error: (e as Error).message };
  }
  try {
    guard.check(trade.usd);
  } catch (e) {
    return { trade, quote: preview.quote, status: "blocked", error: (e as Error).message };
  }
  if (!sendsMoney(ctx)) return { trade, quote: preview.quote, status: "previewed" };

  const isPrivate = config.custody === "confidential";
  // The wallet must be able to receive the bought token, or the payout bounces into a refund.
  // (Not needed when proceeds stay inside the confidential balance.)
  if (!isPrivate) try {
    if (await wallet().ensureRegistered(trade.to.contract)) console.log(`[executor] registered wallet with ${trade.to.symbol} so it can receive proceeds`);
  } catch (e) {
    return { trade, quote: preview.quote, status: "failed", error: `could not register wallet with ${trade.to.symbol}: ${(e as Error).message}` };
  }
  let firm;
  try {
    firm = await requestQuote({ from: trade.from, to: trade.to, amount: trade.amount, dry: false });
  } catch (e) {
    return { trade, quote: preview.quote, status: "failed", error: (e as Error).message };
  }
  const dep = firm.quote.depositAddress;
  if (!dep) return { trade, quote: firm.quote, status: "failed", error: "quote returned no depositAddress" };

  // The private memo: everything an observer would want. Only its hash goes onchain.
  const memo = canonical({
    v: 2,
    custody: config.custody,
    cycle: ctx.cycleId,
    wallet: wallet().id,
    salt: newSalt(),
    trade: {
      from: trade.from.symbol,
      to: trade.to.symbol,
      amountIn: trade.amount.toString(),
      usd: +trade.usd.toFixed(2),
      reason: trade.reason,
      clippedBy: trade.clippedBy,
    },
    quote: {
      depositAddress: dep,
      amountOut: firm.quote.amountOut,
      minAmountOut: firm.quote.minAmountOut,
      signature: firm.signature,
      correlationId: firm.correlationId,
    },
    limits: config.limits,
    thesis: ctx.thesis,
    risk: ctx.riskConcerns,
    inference: ctx.proofs,
  });
  const commitment = sha256Hex(memo);

  let txHash: string;
  try {
    if (isPrivate && config.mode === "live") {
      // Nothing touches the public chain: the agent signs the intent and 1Click settles it in the private shard.
      txHash = await signAndSubmit(dep);
    } else {
      ({ txHash } = await wallet().send({ token: trade.from.contract, amount: trade.amount, depositAddress: dep, commitment }));
    }
  } catch (e) {
    return { trade, quote: firm.quote, status: "failed", error: (e as Error).message };
  }
  guard.recordTrade(trade.usd);
  journal.record(txHash, commitment, memo, isPrivate ? "intent" : "tx");
  if (!isPrivate) await submitDeposit(dep, txHash);
  const s = await waitForSwap(dep);
  if (config.mode === "mock" && s === "SUCCESS") await wallet().credit?.(trade.to.contract, BigInt(firm.quote.amountOut));
  return { trade, quote: firm.quote, status: "executed", txHash, commitment, swapStatus: s };
}
