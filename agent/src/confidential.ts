/**
 * Confidential Intents custody.
 *
 * In this mode the book lives in the wallet's Confidential Intents balance, inside
 * NEAR's private shard. Swaps never touch a public chain: the agent asks 1Click for
 * a quote, signs the generated intent (NEP-413) with its own key, and submits it.
 * Balances and history are readable only with a session token that this wallet's
 * key signs for.
 *
 * Public: the one-time `fund` deposit into the shard and any later `withdraw`.
 * Private: every trade in between, the balances, and the reasoning.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, teraToGas } from "near-api-js";
import { IntentsSDK, VersionedNonceBuilder, createIntentSignerNEP413 } from "@defuse-protocol/intents-sdk";
import { config } from "./config.ts";

const VERIFIER = "intents.near";

function agentKeyPair() {
  return KeyPair.fromString(config.near.agentKey as `ed25519:${string}`);
}
export const agentPublicKey = () => agentKeyPair().getPublicKey().toString();

function signer() {
  const kp = agentKeyPair();
  return createIntentSignerNEP413({
    accountId: config.near.walletId,
    signMessage: (_payload, hash) => {
      const { signature, publicKey } = kp.sign(hash);
      return { publicKey: publicKey.toString(), signature: Buffer.from(signature).toString("base64") };
    },
  });
}

let sdk: IntentsSDK | null = null;
const intentsSdk = () =>
  (sdk ??= new IntentsSDK({ referral: "aureus", rpc: { "near:mainnet": [config.near.rpc] } as never }));

function partnerHeaders(): Record<string, string> {
  if (!config.intents.apiKey) throw new Error("confidential mode needs ONECLICK_API_KEY (partners.near-intents.org)");
  return { "Content-Type": "application/json", "X-API-Key": config.intents.apiKey };
}

async function post<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${config.intents.baseURL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path} -> ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

// ------------------------------------------------------------------ key setup

/** Is the agent's key allowed to sign intents for this wallet on the verifier? */
export async function agentKeyRegistered(): Promise<boolean> {
  const provider = new JsonRpcProvider({ url: config.near.rpc });
  try {
    return Boolean(await provider.callFunction({
      contractId: VERIFIER,
      method: "has_public_key",
      args: { account_id: config.near.walletId, public_key: agentPublicKey() },
    }));
  } catch {
    const keys = (await provider.callFunction({ contractId: VERIFIER, method: "public_keys_of", args: { account_id: config.near.walletId } })) as string[];
    return keys.includes(agentPublicKey());
  }
}

/** One public transaction: the wallet authorises the agent's key on intents.near. */
export async function registerAgentKey(): Promise<string> {
  const account = new Account(config.near.walletId, new JsonRpcProvider({ url: config.near.rpc }), KeyPairSigner.fromSecretKey(config.near.agentKey as `ed25519:${string}`));
  const out = await account.signAndSendTransaction({
    receiverId: VERIFIER,
    actions: [actions.functionCall("add_public_key", { public_key: agentPublicKey() }, teraToGas("100"), 1n)],
  });
  return out.transaction.hash;
}

// ------------------------------------------------------------------- session

interface Session { accessToken: string; refreshToken: string; accessExp: number; refreshExp: number }
const sessionFile = () => join(config.dataDir, "session.json");

function loadSession(): Session | null {
  return existsSync(sessionFile()) ? JSON.parse(readFileSync(sessionFile(), "utf8")) : null;
}
function saveSession(s: Session) {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(sessionFile(), JSON.stringify(s), { mode: 0o600 });
}

/** Prove we control the wallet by signing an empty intent; returns a short-lived bearer token. */
async function authenticate(): Promise<Session> {
  const payload = await intentsSdk()
    .intentBuilder()
    .setSigner(config.near.walletId)
    .setDeadline(new Date(Date.now() + 5 * 60_000))
    // The auth endpoint checks a start timestamp embedded in the nonce's random bytes.
    .setNonceRandomBytes(VersionedNonceBuilder.createTimestampedNonceBytes(new Date()))
    .build();
  const signedData = await signer().signIntent(payload);
  const r = await post<{ accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number }>(
    "/auth/authenticate", { signedData }, { "Content-Type": "application/json" },
  );
  const now = Date.now();
  const s = { accessToken: r.accessToken, refreshToken: r.refreshToken, accessExp: now + (r.expiresIn - 60) * 1000, refreshExp: now + (r.refreshExpiresIn - 60) * 1000 };
  saveSession(s);
  return s;
}

async function token(): Promise<string> {
  let s = loadSession();
  const now = Date.now();
  if (s && s.accessExp > now) return s.accessToken;
  if (s && s.refreshExp > now) {
    try {
      const r = await post<{ accessToken: string; expiresIn: number }>("/auth/refresh", { refreshToken: s.refreshToken }, { "Content-Type": "application/json" });
      s = { ...s, accessToken: r.accessToken, accessExp: now + (r.expiresIn - 60) * 1000 };
      saveSession(s);
      return s.accessToken;
    } catch { /* fall through to a fresh signature */ }
  }
  return (await authenticate()).accessToken;
}

// ------------------------------------------------------------------- reading

/** Private balances, keyed by 1Click assetId (e.g. nep141:wrap.near). */
export async function balances(): Promise<Map<string, bigint>> {
  const res = await fetch(`${config.intents.baseURL}/account/balances`, { headers: { Authorization: `Bearer ${await token()}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click /account/balances -> ${res.status} ${text}`);
  const body = JSON.parse(text) as { balances: { tokenId: string; available: string }[] };
  return new Map(body.balances.map((b) => [b.tokenId, BigInt(b.available)]));
}

/** Private history. Only this wallet's key can read it. */
export async function history(): Promise<unknown> {
  const res = await fetch(`${config.intents.baseURL}/account/history`, { headers: { Authorization: `Bearer ${await token()}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click /account/history -> ${res.status} ${text}`);
  return JSON.parse(text);
}

// ------------------------------------------------------------------- trading

/** Sign the intent 1Click generated for a confidential-balance quote, and submit it. */
export async function signAndSubmit(depositAddress: string): Promise<string> {
  const h = partnerHeaders();
  const gen = await post<{ intent: { standard: string; payload: { message: string; nonce: string; recipient: string; callbackUrl?: string | null } } }>(
    "/generate-intent",
    { type: "swap_transfer", standard: "nep413", signerId: config.near.walletId, depositAddress },
    h,
  );
  // Sign exactly what 1Click returned. Never modify the payload.
  const signedData = await signer().signRaw({ payload: gen.intent.payload });
  const sub = await post<{ intentHash: string }>("/submit-intent", { type: "swap_transfer", signedData }, h);
  return sub.intentHash;
}
