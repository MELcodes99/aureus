import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const Asset = z.object({
  symbol: z.string(),
  /** NEP-141 contract on NEAR. Used to look up the 1Click assetId at runtime. */
  contract: z.string(),
  decimals: z.number().int(),
  stable: z.boolean().default(false),
  /** Skip (instead of failing) if 1Click does not list this token. */
  optional: z.boolean().default(false),
});
export type Asset = z.infer<typeof Asset>;

const Mandate = z.object({
  objective: z.string(),
  riskProfile: z.enum(["conservative", "balanced", "aggressive"]),
  /** Hard ceiling on any one non-stable asset, 0..1. */
  maxSingleAssetWeight: z.number().min(0).max(1),
  /** Floor on stablecoins, 0..1. */
  minStableWeight: z.number().min(0).max(1),
  /** Only rebalance a position when it drifts more than this from target, 0..1. */
  rebalanceThreshold: z.number().min(0).max(1),
  minTradeUsd: z.number().nonnegative(),
});
export type Mandate = z.infer<typeof Mandate>;

const FileConfig = z.object({
  mandate: Mandate,
  universe: z.array(Asset).min(2),
  /** Hard limits enforced in code before every trade (src/guard.ts). */
  limits: z.object({
    maxTradeUsd: z.number().positive(),
    maxDailyUsd: z.number().positive(),
    cooldownMinutes: z.number().nonnegative(),
    /** Drawdown from the NAV high-water mark that stops the agent until you run `resume`. */
    maxDrawdownPct: z.number().min(1).max(100),
    /** Native NEAR always left in the wallet for gas and storage. */
    gasReserveNear: z.number().min(0.1),
  }),
  slippageBps: z.number().int().min(1).max(1000).default(100),
  /**
   * wallet: the book sits in your NEAR wallet; swaps route privately but balances are public.
   * confidential: the book sits in your Confidential Intents balance; trades, balances and
   * history are private. Only `fund` and `withdraw` touch the public chain.
   */
  custody: z.enum(["wallet", "confidential"]).default("wallet"),
});
export type FileConfig = z.infer<typeof FileConfig>;

const env = process.env;
const mode = (env.AUREUS_MODE ?? "mock") as "mock" | "live";
// On a host (e.g. Render) the mandate comes from the AUREUS_CONFIG_JSON secret instead of a file,
// so your strategy is never committed to the repo.
function loadConfigJson(): unknown {
  if (env.AUREUS_CONFIG_JSON) return JSON.parse(env.AUREUS_CONFIG_JSON);
  const cfgPath = resolve(env.AUREUS_CONFIG ?? "aureus.config.json");
  if (!existsSync(cfgPath)) throw new Error(`config not found: ${cfgPath} (copy aureus.config.example.json, or set AUREUS_CONFIG_JSON)`);
  return JSON.parse(readFileSync(cfgPath, "utf8"));
}
const file = FileConfig.parse(loadConfigJson());

function need(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name} (required in live mode, see .env.example)`);
  return v;
}

export const config = {
  mode,
  ...file,
  /** Sends real funds only when explicitly enabled. Otherwise every quote is dry. */
  execute: env.AUREUS_EXECUTE === "true",
  dataDir: resolve(env.AUREUS_DATA_DIR ?? ".aureus"),
  journalKeyHex: env.AUREUS_JOURNAL_KEY ?? "",
  nearAi: {
    baseURL: env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1",
    get apiKey() { return mode === "live" ? need("NEAR_AI_API_KEY") : "mock"; },
    model: env.NEAR_AI_MODEL ?? "zai-org/GLM-5.1-FP8",
    requireAttestation: env.NEAR_AI_REQUIRE_ATTESTATION !== "false",
  },
  near: {
    network: env.NEAR_NETWORK ?? "mainnet",
    rpc: env.NEAR_RPC ?? "https://rpc.mainnet.near.org",
    /** The trading wallet the user created and funded. The agent signs for it with its own key. */
    get walletId() { return mode === "live" ? need("AUREUS_WALLET_ID") : "trading-wallet.mock.near"; },
    /** Agent's own full-access key on the trading wallet. The user can delete it at any time. */
    get agentKey() { return need("AUREUS_AGENT_KEY"); },
  },
  intents: {
    baseURL: env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com/v0",
    /** Optional. Without a key 1Click charges a 0.2% fee. Register at partners.near-intents.org. */
    apiKey: env.ONECLICK_API_KEY ?? "",
  },
};
export type Config = typeof config;
