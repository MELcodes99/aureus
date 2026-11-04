/**
 * NEAR Intents 1Click API with Confidential Intents.
 *
 * Every quote is requested with confidentiality "advanced": the swap is routed
 * through NEAR's private shard, so the route and the solver-side trail are not
 * visible onchain. The wallet's own deposit and receipt are public transfers.
 * Quotes are dry (no deposit address) unless AUREUS_EXECUTE=true.
 */
import { config, type Asset } from "./config.ts";
import { mockQuote, mockTokens } from "./mock.ts";

export interface IntentsToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt?: string;
  contractAddress?: string | null;
}

export interface Quote {
  depositAddress?: string;
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
}

export interface QuoteResult {
  quote: Quote;
  signature?: string;
  correlationId?: string;
  request: Record<string, unknown>;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (config.intents.apiKey) h["X-API-Key"] = config.intents.apiKey;
  return h;
}

export async function listTokens(): Promise<IntentsToken[]> {
  if (config.mode === "mock") return mockTokens();
  const res = await fetch(`${config.intents.baseURL}/tokens`, { headers: headers() });
  if (!res.ok) throw new Error(`1Click /tokens -> ${res.status}`);
  const raw = (await res.json()) as Array<IntentsToken & { price: number | string }>;
  return raw.map((t) => ({ ...t, price: Number(t.price) }));
}

/** Map our universe onto 1Click assetIds. Never construct assetIds by hand. */
export function resolveAssets(universe: Asset[], tokens: IntentsToken[]) {
  const out: Array<Asset & { assetId: string; price: number }> = [];
  for (const a of universe) {
    const t = tokens.find(
      (t) => t.blockchain === "near" && (t.contractAddress === a.contract || t.assetId === `nep141:${a.contract}`),
    );
    if (!t) {
      if (a.optional) continue;
      throw new Error(`${a.symbol} (${a.contract}) is not supported by 1Click`);
    }
    out.push({ ...a, assetId: t.assetId, price: t.price });
  }
  return out;
}
export type ResolvedAsset = ReturnType<typeof resolveAssets>[number];

export async function requestQuote(args: {
  from: ResolvedAsset;
  to: ResolvedAsset;
  amount: bigint;
  dry: boolean;
  /**
   * wallet:   wallet -> private shard -> wallet (default custody)
   * private:  confidential balance -> confidential balance (nothing public)
   * fund:     wallet -> confidential balance (one public deposit)
   * withdraw: confidential balance -> wallet (one public payout)
   */
  route?: "wallet" | "private" | "fund" | "withdraw";
}): Promise<QuoteResult> {
  const walletId = config.near.walletId;
  const route = args.route ?? (config.custody === "confidential" ? "private" : "wallet");
  const fromPrivate = route === "private" || route === "withdraw";
  const toPrivate = route === "private" || route === "fund";
  const request = {
    dry: args.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: config.slippageBps,
    originAsset: args.from.assetId,
    depositType: fromPrivate ? "CONFIDENTIAL_INTENTS" : "ORIGIN_CHAIN",
    destinationAsset: args.to.assetId,
    amount: args.amount.toString(),
    // Proceeds and refunds both come back to the same owner: the wallet, or its private balance.
    refundTo: walletId,
    refundType: fromPrivate ? "CONFIDENTIAL_INTENTS" : "ORIGIN_CHAIN",
    recipient: walletId,
    recipientType: toPrivate ? "CONFIDENTIAL_INTENTS" : "DESTINATION_CHAIN",
    confidentiality: "advanced",
    deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
    referral: "aureus",
  };
  if (config.mode === "mock") return { quote: mockQuote(args.from, args.to, args.amount, args.dry), request };

  const res = await fetch(`${config.intents.baseURL}/quote`, { method: "POST", headers: headers(), body: JSON.stringify(request) });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click /quote -> ${res.status} ${text}`);
  const body = JSON.parse(text);
  return { quote: body.quote, signature: body.signature, correlationId: body.correlationId, request };
}

export async function swapStatus(depositAddress: string): Promise<string> {
  if (config.mode === "mock") return "SUCCESS";
  const res = await fetch(`${config.intents.baseURL}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: headers() });
  if (!res.ok) throw new Error(`1Click /status -> ${res.status}`);
  return ((await res.json()) as { status: string }).status;
}

export async function submitDeposit(depositAddress: string, txHash: string): Promise<void> {
  if (config.mode === "mock") return;
  await fetch(`${config.intents.baseURL}/deposit/submit`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ depositAddress, txHash }),
  }).catch(() => undefined); // optional speed-up, never fatal
}
