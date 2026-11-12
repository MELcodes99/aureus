/**
 * Market context for the Strategist: multi-horizon trend, volume and daily range.
 * 1Click gives a live price but no history, and the scout's own samples only cover a few hours.
 * CoinGecko's public markets endpoint fills the gap with 24h / 7d / 30d change in one call.
 * Public market data only, nothing about the owner. If it fails, the cycle carries on without it.
 */
import { config } from "./config.ts";

export interface MarketContext {
  change24hPct: number | null;
  change7dPct: number | null;
  change30dPct: number | null;
  /** Today's high-low range as a % of price: a rough daily volatility. */
  range24hPct: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
}

/** CoinGecko ids for the universe. Wrapped / bridged tokens track their underlying. */
const IDS: Record<string, string> = {
  USDC: "usd-coin",
  USDT: "tether",
  wNEAR: "near",
  NEAR: "near",
  ETH: "ethereum",
  BTC: "bitcoin",
};

let cache: { at: number; data: Record<string, MarketContext> } | null = null;
const round = (x: unknown, d = 2) => (typeof x === "number" && Number.isFinite(x) ? +x.toFixed(d) : null);

export async function marketContext(symbols: string[]): Promise<Record<string, MarketContext>> {
  if (config.mode === "mock") return {};
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.data;
  const ids = [...new Set(symbols.map((s) => IDS[s]).filter(Boolean))];
  if (!ids.length) return {};
  const key = process.env.COINGECKO_API_KEY;
  const q = new URLSearchParams({ vs_currency: "usd", ids: ids.join(","), price_change_percentage: "24h,7d,30d" });
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?${q}`, {
      headers: key ? { "x-cg-demo-api-key": key } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`CoinGecko -> ${res.status}`);
    const rows = (await res.json()) as Array<Record<string, number | string | null>>;
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const data: Record<string, MarketContext> = {};
    for (const s of symbols) {
      const r = byId.get(IDS[s]);
      if (!r) continue;
      const price = Number(r.current_price);
      const hi = Number(r.high_24h);
      const lo = Number(r.low_24h);
      data[s] = {
        change24hPct: round(r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h),
        change7dPct: round(r.price_change_percentage_7d_in_currency),
        change30dPct: round(r.price_change_percentage_30d_in_currency),
        range24hPct: price > 0 && hi > 0 && lo > 0 ? round(((hi - lo) / price) * 100) : null,
        volume24hUsd: round(r.total_volume, 0),
        marketCapUsd: round(r.market_cap, 0),
      };
    }
    cache = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.log(`[scout] market context unavailable (${(e as Error).message}); using own price history only`);
    return cache?.data ?? {};
  }
}
