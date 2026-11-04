/**
 * Scout: builds the market and portfolio picture. No LLM, no secrets.
 * Prices come from the 1Click token list; balances from the trading wallet
 * (native NEAR above the gas reserve counts as wNEAR, it is wrapped on demand).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { listTokens, resolveAssets, type ResolvedAsset } from "../intents.ts";
import { wallet } from "../wallet.ts";
import * as confidential from "../confidential.ts";

export interface MarketAsset {
  symbol: string;
  stable: boolean;
  price: number;
  momentumPct: number | null;
  volatilityPct: number | null;
}
export interface Holding {
  asset: ResolvedAsset;
  units: bigint;
  usd: number;
  weight: number;
}
export interface Snapshot {
  at: string;
  assets: ResolvedAsset[];
  market: MarketAsset[];
  holdings: Holding[];
  navUsd: number;
}

type PricePoint = { at: string; prices: Record<string, number> };
const LOOKBACK = 5;

function loadHistory(): PricePoint[] {
  const f = join(config.dataDir, "prices.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
}
function saveHistory(h: PricePoint[]) {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, "prices.json"), JSON.stringify(h.slice(-200)));
}

export const toUnits = (amount: number, decimals: number): bigint => {
  const [i, f = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
};
export const fromUnits = (units: bigint, decimals: number): number => Number(units) / 10 ** decimals;

export async function scout(): Promise<Snapshot> {
  const assets = resolveAssets(config.universe, await listTokens());
  const history = loadHistory();
  const now = { at: new Date().toISOString(), prices: Object.fromEntries(assets.map((a) => [a.symbol, a.price])) };

  const market: MarketAsset[] = assets.map((a) => {
    const series = [...history.map((h) => h.prices[a.symbol]).filter((p) => p !== undefined), a.price];
    const past = series.length > 1 ? series[Math.max(0, series.length - 1 - LOOKBACK)] : null;
    const rets = series.slice(1).map((p, i) => p / series[i] - 1).slice(-LOOKBACK);
    const mean = rets.reduce((x, y) => x + y, 0) / (rets.length || 1);
    const vol = rets.length > 1 ? Math.sqrt(rets.reduce((x, r) => x + (r - mean) ** 2, 0) / (rets.length - 1)) : null;
    return {
      symbol: a.symbol,
      stable: a.stable,
      price: a.price,
      momentumPct: past ? +((a.price / past - 1) * 100).toFixed(2) : null,
      volatilityPct: vol === null ? null : +(vol * 100).toFixed(2),
    };
  });
  saveHistory([...history, now]);

  const holdings: Holding[] = [];
  const priv = config.custody === "confidential" && config.mode === "live" ? await confidential.balances() : null;
  for (const a of assets) {
    const units = priv ? priv.get(a.assetId) ?? 0n : await wallet().balance(a.contract);
    holdings.push({ asset: a, units, usd: fromUnits(units, a.decimals) * a.price, weight: 0 });
  }
  const navUsd = holdings.reduce((s, h) => s + h.usd, 0);
  holdings.forEach((h) => (h.weight = navUsd ? h.usd / navUsd : 0));
  return { at: now.at, assets, market, holdings, navUsd };
}
