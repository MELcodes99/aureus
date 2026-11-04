/**
 * The user's trading wallet.
 *
 * The user creates a NEAR wallet, funds it with what the agent may trade, and
 * adds the agent's public key to it. The agent signs with that key; the user
 * keeps their own seed phrase, so they can withdraw or delete the agent's key
 * at any time.
 *
 * Each trade is ONE transaction to the token contract:
 *   [near_deposit (wrap NEAR, if needed)] + [storage_deposit for the 1Click
 *   deposit address, if needed] + ft_transfer(memo = "aureus:<commitment>")
 * so the commitment to the private reasoning is onchain, and only the hash.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type Action } from "near-api-js";
import { config } from "./config.ts";

export const WNEAR = "wrap.near";
const YOCTO = 10n ** 24n;
const ONE_YOCTO = 1n;
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, standard NEP-145 minimum

export interface SendArgs {
  token: string;
  amount: bigint;
  depositAddress: string;
  /** Written as memo "aureus:<commitment>". Omit for transfers that are not trades (e.g. funding). */
  commitment?: string;
}

export interface WalletClient {
  id: string;
  /** Spendable balance per token contract. For wrap.near this includes native NEAR above the gas reserve. */
  balance(token: string): Promise<bigint>;
  nativeNear(): Promise<bigint>;
  send(a: SendArgs): Promise<{ txHash: string }>;
  /** The aureus commitment written in a past transfer's memo, or null. */
  commitmentOf(txHash: string): Promise<string | null>;
  /** Make sure this wallet can RECEIVE `token` (NEP-145 storage), so swap proceeds are not bounced. */
  ensureRegistered(token: string): Promise<boolean>;
  /** Publish a Merkle root of private commitments in a cheap public transaction. */
  anchor(root: string, count: number): Promise<{ txHash: string }>;
  /** The aureus anchor root recorded in a past transaction, or null. */
  anchorOf(txHash: string): Promise<string | null>;
  /** mock only: swap proceeds arriving */
  credit?(token: string, amount: bigint): Promise<void>;
}

const reserveYocto = () => BigInt(Math.round(config.limits.gasReserveNear * 1e6)) * 10n ** 18n;
export const memoFor = (commitment: string) => `aureus:${commitment}`;
const parseMemo = (memo: unknown) => (typeof memo === "string" && memo.startsWith("aureus:") ? memo.slice(7) : null);

// ---------------------------------------------------------------------- live

class LiveWallet implements WalletClient {
  readonly id = config.near.walletId;
  private provider = new JsonRpcProvider({ url: config.near.rpc });
  private account = new Account(this.id, this.provider, KeyPairSigner.fromSecretKey(config.near.agentKey as `ed25519:${string}`));

  private view<T>(contractId: string, method: string, args: Record<string, unknown>) {
    return this.provider.callFunction({ contractId, method, args }) as Promise<T>;
  }
  async nativeNear() { return (await this.account.getState()).balance.available; }
  private async ft(token: string) { return BigInt((await this.view<string>(token, "ft_balance_of", { account_id: this.id })) ?? "0"); }

  async balance(token: string) {
    const ft = await this.ft(token).catch(() => 0n);
    if (token !== WNEAR) return ft;
    const spare = (await this.nativeNear()) - reserveYocto();
    return ft + (spare > 0n ? spare : 0n);
  }

  async send(a: SendArgs) {
    const acts: Action[] = [];
    if (a.token === WNEAR) {
      const wrapped = await this.ft(WNEAR).catch(() => 0n);
      if (wrapped < a.amount) {
        const need = a.amount - wrapped;
        const spare = (await this.nativeNear()) - reserveYocto();
        if (need > spare) throw new Error(`not enough NEAR above the ${config.limits.gasReserveNear} NEAR gas reserve`);
        const registered = await this.view(WNEAR, "storage_balance_of", { account_id: this.id });
        if (!registered) acts.push(actions.functionCall("storage_deposit", { account_id: this.id }, teraToGas("10"), STORAGE_DEPOSIT));
        acts.push(actions.functionCall("near_deposit", {}, teraToGas("10"), need));
      }
    }
    const recvRegistered = await this.view(a.token, "storage_balance_of", { account_id: a.depositAddress }).catch(() => null);
    if (!recvRegistered) acts.push(actions.functionCall("storage_deposit", { account_id: a.depositAddress, registration_only: true }, teraToGas("10"), STORAGE_DEPOSIT));
    acts.push(actions.functionCall(
      "ft_transfer",
      { receiver_id: a.depositAddress, amount: a.amount.toString(), ...(a.commitment ? { memo: memoFor(a.commitment) } : {}) },
      teraToGas("30"),
      ONE_YOCTO,
    ));
    const out = await this.account.signAndSendTransaction({ receiverId: a.token, actions: acts });
    return { txHash: out.transaction.hash };
  }

  // The anchor is a read-only call (wNEAR's ft_balance_of) made as a transaction, so it moves
  // nothing and costs only gas; the extra argument is ignored by the contract but recorded
  // onchain forever, readable on any explorer.
  async anchor(root: string, count: number) {
    const out = await this.account.signAndSendTransaction({
      receiverId: WNEAR,
      actions: [actions.functionCall("ft_balance_of", { account_id: this.id, aureus_anchor: root, commitments: count }, teraToGas("5"), 0n)],
      throwOnFailure: false,
    });
    return { txHash: out.transaction.hash };
  }

  async anchorOf(txHash: string) {
    const tx = await this.provider.viewTransactionStatus({ txHash, accountId: this.id, waitUntil: "FINAL" });
    for (const act of (tx.transaction as any).actions ?? []) {
      const fc = act.FunctionCall;
      if (!fc) continue;
      const args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8"));
      if (typeof args.aureus_anchor === "string") return args.aureus_anchor as string;
    }
    return null;
  }

  async ensureRegistered(token: string) {
    const reg = await this.view(token, "storage_balance_of", { account_id: this.id }).catch(() => null);
    if (reg) return false;
    await this.account.signAndSendTransaction({
      receiverId: token,
      actions: [actions.functionCall("storage_deposit", { account_id: this.id, registration_only: true }, teraToGas("10"), STORAGE_DEPOSIT)],
    });
    return true;
  }

  async commitmentOf(txHash: string) {
    const tx = await this.provider.viewTransactionStatus({ txHash, accountId: this.id, waitUntil: "FINAL" });
    for (const act of (tx.transaction as any).actions ?? []) {
      const fc = act.FunctionCall;
      if (fc?.method_name !== "ft_transfer") continue;
      const args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8"));
      const c = parseMemo(args.memo);
      if (c) return c;
    }
    return null;
  }
}

// ---------------------------------------------------------------------- mock

interface MockState { balances: Record<string, string>; native: string; txs: Record<string, { token: string; amount: string; to: string; memo: string }> }

class MockWallet implements WalletClient {
  readonly id = config.near.walletId;
  private file = join(config.dataDir, "mock-wallet.json");
  private s: MockState;
  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.s = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : JSON.parse(readFileSync(new URL("../fixtures/mock-wallet.json", import.meta.url), "utf8"));
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.s, null, 2)); }
  async nativeNear() { return BigInt(this.s.native); }
  async balance(token: string) {
    const ft = BigInt(this.s.balances[token] ?? "0");
    if (token !== WNEAR) return ft;
    const spare = BigInt(this.s.native) - reserveYocto();
    return ft + (spare > 0n ? spare : 0n);
  }
  async send(a: SendArgs) {
    if (a.token === WNEAR) {
      const wrapped = BigInt(this.s.balances[WNEAR] ?? "0");
      if (wrapped < a.amount) {
        const need = a.amount - wrapped;
        if (need > BigInt(this.s.native) - reserveYocto()) throw new Error("not enough NEAR above the gas reserve");
        this.s.native = (BigInt(this.s.native) - need).toString();
        this.s.balances[WNEAR] = a.amount.toString();
      }
    }
    const bal = BigInt(this.s.balances[a.token] ?? "0");
    if (bal < a.amount) throw new Error(`insufficient ${a.token}`);
    this.s.balances[a.token] = (bal - a.amount).toString();
    const txHash = `mocktx${Object.keys(this.s.txs).length.toString().padStart(4, "0")}`;
    this.s.txs[txHash] = { token: a.token, amount: a.amount.toString(), to: a.depositAddress, memo: a.commitment ? memoFor(a.commitment) : "" };
    this.save();
    return { txHash };
  }
  async commitmentOf(txHash: string) { return parseMemo(this.s.txs[txHash]?.memo); }
  async ensureRegistered(_token: string) { return false; }
  async anchor(root: string, _count: number) {
    const txHash = `mockanchor${Object.keys(this.s.txs).length.toString().padStart(4, "0")}`;
    this.s.txs[txHash] = { token: WNEAR, amount: "0", to: WNEAR, memo: `anchor:${root}` };
    this.save();
    return { txHash };
  }
  async anchorOf(txHash: string) {
    const m = this.s.txs[txHash]?.memo;
    return m?.startsWith("anchor:") ? m.slice(7) : null;
  }
  async credit(token: string, amount: bigint) {
    this.s.balances[token] = (BigInt(this.s.balances[token] ?? "0") + amount).toString();
    this.save();
  }
}

let instance: WalletClient | null = null;
export const wallet = (): WalletClient => (instance ??= config.mode === "mock" ? new MockWallet() : new LiveWallet());
export const formatNear = (yocto: bigint) => (Number(yocto) / Number(YOCTO)).toFixed(4);
