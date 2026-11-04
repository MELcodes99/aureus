#!/usr/bin/env -S npx tsx
import { rmSync } from "node:fs";
import { KeyPair, keyToImplicitAddress } from "near-api-js";
import { config } from "./config.ts";
import { runCycle } from "./cycle.ts";
import * as guard from "./guard.ts";
import * as journal from "./journal.ts";
import { formatNear, wallet } from "./wallet.ts";
import { merkleRoot, sha256Hex } from "./crypto.ts";
import * as confidential from "./confidential.ts";
import { listTokens, requestQuote, resolveAssets, submitDeposit, swapStatus } from "./intents.ts";
import { toUnits } from "./agents/scout.ts";

async function asset(symbol: string) {
  const a = resolveAssets(config.universe, await listTokens()).find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!a) throw new Error(`unknown symbol ${symbol}. Known: ${config.universe.map((u) => u.symbol).join(", ")}`);
  return a;
}

async function waitFor(depositAddress: string) {
  const end = Date.now() + 300_000;
  let s = await swapStatus(depositAddress);
  while (!["SUCCESS", "FAILED", "REFUNDED"].includes(s) && Date.now() < end) {
    process.stdout.write(`  status ${s}...\r`);
    await new Promise((r) => setTimeout(r, 5_000));
    s = await swapStatus(depositAddress);
  }
  process.stdout.write(`\r${" ".repeat(40)}\r`);
  return s;
}

/** fund/withdraw move the owner's own money; tell the guard so it is never read as profit or loss. */
function flow(usd: number, direction: "in" | "out") {
  // "in" = into the private balance. That grows the book in confidential custody, shrinks it in wallet custody.
  const toBook = (direction === "in") === (config.custody === "confidential");
  guard.adjustForFlow(toBook ? usd : -usd);
}

function needLive(what: string) {
  if (config.mode !== "live") throw new Error(`${what} needs AUREUS_MODE=live`);
}

const [cmd = "help", ...args] = process.argv.slice(2);

const banner = () =>
  console.log(
    `AUREUS  mode=${config.mode}  wallet=${config.near.walletId}  ` +
      `${config.mode === "mock" ? "SIMULATED" : config.execute ? "LIVE EXECUTION" : "DRY (quotes only)"}`,
  );

async function main() {
  switch (cmd) {
    case "agent-key": {
      // Generate the agent's own key. The user adds its PUBLIC half to their trading wallet.
      const kp = KeyPair.fromRandom("ed25519");
      const pub = kp.getPublicKey().toString();
      console.log(`Agent key generated.

1) Put this line in agent/.env (keep it secret, never commit it):
AUREUS_AGENT_KEY=${kp.toString()}

2) Add the PUBLIC key to your trading wallet, signed with YOUR wallet's key:
near account add-key <YOUR_WALLET> grant-full-access use-manually-provided-public-key ${pub} network-config mainnet sign-with-keychain send

Public key: ${pub}
(If you would rather give the agent a brand-new wallet, this key's implicit account is ${keyToImplicitAddress(pub)}.
 Fund it, then add YOUR key to it so you can always withdraw.)`);
      break;
    }
    case "revoke": {
      console.log(`The onchain kill switch. Delete the agent's key from your wallet, signed with YOUR key:
near account delete-keys ${config.mode === "live" ? config.near.walletId : "<YOUR_WALLET>"} public-keys <AGENT_PUBLIC_KEY> network-config mainnet sign-with-keychain send

After that the agent cannot sign anything. Your funds stay in your wallet.`);
      break;
    }
    case "serve": {
      const { start } = await import("./server.ts");
      start();
      return;
    }
    case "export-state": {
      // Bundle the journal and state for a host's AUREUS_SEED_B64. Memos stay AES-encrypted;
      // the host also needs the same AUREUS_JOURNAL_KEY to disclose them. Session tokens are excluded.
      const { existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const names = ["journal.jsonl", "anchors.jsonl", "guard.json", "prices.json", "public.json", "last-cycle.json"];
      const bundle: Record<string, string> = {};
      for (const n of names) if (existsSync(join(config.dataDir, n))) bundle[n] = readFileSync(join(config.dataDir, n), "utf8");
      const b64 = Buffer.from(JSON.stringify(bundle)).toString("base64");
      console.error(`files: ${Object.keys(bundle).join(", ")}  (${b64.length} chars)`);
      console.log(b64);
      break;
    }
    case "cycle": {
      banner();
      await runCycle();
      break;
    }
    case "run": {
      const mins = Number(args[0] ?? 15);
      banner();
      for (;;) {
        try { await runCycle(); } catch (e) { console.error(`[cycle] error: ${(e as Error).message}`); }
        console.log(`[run] next cycle in ${mins} min`);
        await new Promise((r) => setTimeout(r, mins * 60_000));
      }
    }
    case "status": {
      banner();
      const w = wallet();
      console.log(`custody: ${config.custody}${config.custody === "confidential" ? " (book in your private Confidential Intents balance; run `private-balances`)" : ""}`);
      if (config.custody === "confidential" && config.mode === "live") {
        const all = resolveAssets(config.universe, await listTokens());
        console.log("\nprivate balance (Confidential Intents, only you can read this):");
        for (const [id, v] of await confidential.balances()) {
          const a = all.find((x) => x.assetId === id);
          console.log(a ? `  ${a.symbol.padEnd(6)} ${(Number(v) / 10 ** a.decimals).toFixed(6)}  ($${((Number(v) / 10 ** a.decimals) * a.price).toFixed(2)})` : `  ${id} ${v}`);
        }
        console.log("\nwallet (public):");
      }
      console.log(`native NEAR: ${formatNear(await w.nativeNear())} (reserve ${config.limits.gasReserveNear} kept for gas)`);
      for (const a of config.universe) {
        const b = await w.balance(a.contract).catch(() => 0n);
        if (b > 0n) console.log(`  ${a.symbol.padEnd(6)} ${(Number(b) / 10 ** a.decimals).toFixed(6)}`);
      }
      const g = guard.status();
      console.log(`\nguard: ${g.paused ? `PAUSED (${g.pauseReason})` : "active"}  drawdown ${g.drawdownPct}% / ${g.limits.maxDrawdownPct}%  ` +
        `today $${g.spentTodayUsd} of $${g.limits.maxDailyUsd}  per-trade cap $${g.limits.maxTradeUsd}`);
      const j = journal.entries();
      const pend = journal.unanchored().length;
      console.log(`\n${j.length} trade(s). Public-wallet trades show only memo aureus:<hash>; private trades show nothing.${pend ? ` ${pend} private decision(s) not yet anchored (run \`anchor\`).` : ""}`);
      for (const e of j.slice(-10)) console.log(`  #${e.n} ${e.at.slice(0, 16)} ${e.kind === "intent" ? "private" : "tx     "} ${e.txHash}  ${e.commitment.slice(0, 16)}...`);
      break;
    }
    case "attest": {
      needLive("attest");
      const { attestationReport } = await import("./nearai.ts");
      const { canonical } = await import("./crypto.ts");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { nonce, report } = await attestationReport();
      const text = JSON.stringify(report);
      const signer = text.match(/"signing_address"\s*:\s*"(0x[0-9a-fA-F]{40})"/)?.[1] ?? "(not found)";
      mkdirSync(config.dataDir, { recursive: true });
      const file = `${config.dataDir}/attestation-${Date.now()}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`model            ${config.nearAi.model}`);
      console.log(`nonce (ours)     ${nonce}  ${text.includes(nonce) ? "echoed in report: fresh" : "NOT echoed"}`);
      console.log(`TEE quote        ${/intel_quote|tdx/i.test(text) ? "Intel TDX present" : "missing"}${/nvidia_payload/i.test(text) ? ", NVIDIA GPU attestation present" : ""}`);
      console.log(`enclave signer   ${signer}`);
      console.log(`report sha256    ${sha256Hex(canonical(report))}`);
      console.log(`\nFull report saved: ${file}`);
      console.log("Verify it independently, without trusting AUREUS:");
      console.log("  - paste the Intel quote into https://proof.t16z.com");
      console.log("  - or run NEAR AI's open-source verifier: https://github.com/nearai/nearai-cloud-verifier");
      console.log("The enclave signer above should match the signingAddress in your disclosed trades.");
      break;
    }
    case "private-setup": {
      needLive("private-setup");
      console.log(`wallet ${config.near.walletId}\nagent key ${confidential.agentPublicKey()}`);
      if (await confidential.agentKeyRegistered()) {
        console.log("1/2 agent key already authorised on intents.near");
      } else {
        console.log("1/2 authorising the agent key on intents.near (one public tx, 1 yoctoNEAR + gas)...");
        console.log(`    tx ${await confidential.registerAgentKey()}`);
      }
      console.log("2/2 signing in to the private ledger...");
      const b = await confidential.balances();
      console.log(`    OK. ${b.size} private balance(s).`);
      for (const [id, v] of b) console.log(`    ${id}  ${v}`);
      console.log("\nNext: move funds in with `fund <SYMBOL> <amount>`, then set \"custody\": \"confidential\" in aureus.config.json.");
      break;
    }
    case "private-balances": {
      needLive("private-balances");
      const all = resolveAssets(config.universe, await listTokens());
      const b = await confidential.balances();
      if (!b.size) console.log("(empty)");
      for (const [id, v] of b) {
        const a = all.find((x) => x.assetId === id);
        console.log(a ? `  ${a.symbol.padEnd(6)} ${(Number(v) / 10 ** a.decimals).toFixed(6)}  ($${((Number(v) / 10 ** a.decimals) * a.price).toFixed(2)})` : `  ${id} ${v}`);
      }
      break;
    }
    case "history": {
      needLive("history");
      console.log(JSON.stringify(await confidential.history(), null, 2));
      break;
    }
    case "fund": {
      // wallet -> private balance. One public deposit; from then on trading is private.
      needLive("fund");
      const [sym, amt, asSym] = args;
      if (!sym || !amt) throw new Error("usage: fund <SYMBOL> <amount> [as <SYMBOL>]   e.g. fund wNEAR 1.5   or   fund wNEAR 1.5 USDC");
      const from = await asset(sym);
      const to = asSym ? await asset(asSym === "as" ? args[3] : asSym) : from;
      const amount = toUnits(Number(amt), from.decimals);
      const q = await requestQuote({ from, to, amount, dry: false, route: "fund" });
      const dep = q.quote.depositAddress;
      if (!dep) throw new Error("quote returned no deposit address");
      console.log(`funding: ${amt} ${from.symbol} -> private ${to.symbol} (~${q.quote.amountOutFormatted})`);
      const { txHash } = await wallet().send({ token: from.contract, amount, depositAddress: dep });
      console.log(`  deposit tx ${txHash} (public: this is the one visible step)`);
      await submitDeposit(dep, txHash);
      const fs = await waitFor(dep);
      console.log(`  ${fs}`);
      if (fs === "SUCCESS") flow(Number(q.quote.amountInUsd) || 0, "in");
      break;
    }
    case "withdraw": {
      // private balance -> wallet. One public payout.
      needLive("withdraw");
      const [sym, amt] = args;
      if (!sym || !amt) throw new Error("usage: withdraw <SYMBOL> <amount|all>");
      const a = await asset(sym);
      const bal = (await confidential.balances()).get(a.assetId) ?? 0n;
      const amount = amt === "all" ? bal : toUnits(Number(amt), a.decimals);
      if (amount <= 0n || amount > bal) throw new Error(`private ${a.symbol} balance is ${bal}`);
      await wallet().ensureRegistered(a.contract);
      const q = await requestQuote({ from: a, to: a, amount, dry: false, route: "withdraw" });
      const dep = q.quote.depositAddress;
      if (!dep) throw new Error("quote returned no deposit address");
      console.log(`withdrawing ${a.symbol} to ${config.near.walletId}`);
      console.log(`  intent ${await confidential.signAndSubmit(dep)}`);
      const ws = await waitFor(dep);
      console.log(`  ${ws}`);
      if (ws === "SUCCESS") flow(Number(q.quote.amountInUsd) || 0, "out");
      break;
    }
    case "disclose": {
      const ref = args[0];
      if (!ref) throw new Error("usage: disclose <trade number | tx hash>");
      const opened = journal.open(ref);
      if (!opened) throw new Error(`no journal entry for ${ref} on this machine`);
      console.log(JSON.stringify(JSON.parse(opened.memo), null, 2));
      if (opened.entry.kind === "intent") {
        const h = sha256Hex(opened.memo);
        const local = opened.entry.commitment === h;
        console.log(`\nprivate intent ${opened.entry.txHash} (settled in the private shard, no trade tx onchain)`);
        console.log(`sha256(memo above):  ${h}`);
        const a = journal.anchorFor(opened.entry.commitment);
        if (!a) {
          console.log(local ? "MATCH with the local journal only. Not anchored yet: run `anchor` to make it provable against the chain." : "NO MATCH");
          process.exitCode = local ? 0 : 1;
          break;
        }
        const onchain = await wallet().anchorOf(a.txHash);
        const ok = local && a.leaves.includes(h) && merkleRoot(a.leaves) === a.root && onchain === a.root;
        console.log(`anchored in tx ${a.txHash} (${a.at.slice(0, 16)}) root ${onchain ?? "(not found)"}`);
        console.log(`this commitment is 1 of ${a.leaves.length} under that root; recomputed root ${merkleRoot(a.leaves)}`);
        console.log(ok ? "MATCH: this reasoning existed, unchanged, no later than the anchor transaction." : "NO MATCH");
        process.exitCode = ok ? 0 : 1;
        break;
      }
      const onchain = await wallet().commitmentOf(opened.entry.txHash);
      const ok = onchain === sha256Hex(opened.memo);
      console.log(`\ntx ${opened.entry.txHash} memo: aureus:${onchain ?? "(none found)"}`);
      console.log(`sha256(memo above):  ${sha256Hex(opened.memo)}`);
      console.log(ok ? "MATCH: this is exactly the reasoning the agent committed to onchain before trading." : "NO MATCH");
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case "anchor": {
      const pending = journal.unanchored();
      if (!pending.length) { console.log("nothing to anchor: every private decision is already anchored"); break; }
      const leaves = pending.map((e) => e.commitment);
      const root = merkleRoot(leaves);
      const { txHash } = await wallet().anchor(root, leaves.length);
      journal.recordAnchor({ at: new Date().toISOString(), txHash, root, leaves });
      console.log(`anchored ${leaves.length} private decision(s) under root ${root}`);
      console.log(`  tx ${txHash}`);
      console.log("Public: only the root and the count. Each decision stays private until you `disclose` it.");
      break;
    }
    case "pause": {
      guard.pause(args.join(" ") || "owner pause");
      console.log("[owner] agent paused. It will not trade until you run `resume`.");
      break;
    }
    case "resume": {
      guard.resume();
      console.log("[owner] resumed. Drawdown is now measured from the current NAV.");
      break;
    }
    case "reset": {
      if (config.mode !== "mock") throw new Error("reset is mock-only (it would wipe your live journal)");
      rmSync(config.dataDir, { recursive: true, force: true });
      console.log(`cleared ${config.dataDir}`);
      break;
    }
    default:
      console.log(`usage: tsx src/cli.ts <command>

  agent-key            generate the agent's key and show how to add it to your wallet
  serve                local API for the dashboard (127.0.0.1 only, token-protected, cannot trade)
  export-state         print your journal and state as one base64 value for a host's AUREUS_SEED_B64
  serve                API for the dashboard + optional autonomous loop (token-protected; the API itself cannot trade)
  cycle                run one cycle
  run [minutes]        run forever, one cycle every N minutes (default 15)
  status               wallet balances, guard state, recent trades
  disclose <n|tx>      reveal one decision and prove it against its onchain memo
  anchor               publish one Merkle root of recent private decisions (proves them later, reveals nothing)
  pause | resume       stop / restart the agent (guard)
  revoke               how to delete the agent's key from your wallet (onchain kill switch)

  attest               fetch and save the enclave's attestation report for independent verification
  private-setup        authorise the agent on intents.near and sign in to your private ledger
  fund <SYM> <amt> [TO]  move funds from the wallet into your private balance (one public deposit)
  private-balances     show your Confidential Intents balances (only you can read them)
  history              your private trade history
  withdraw <SYM> <amt|all>  move funds from the private balance back to the wallet
  reset                mock mode only: start over`);
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
