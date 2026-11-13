# AUREUS

**Private Intelligence. Autonomous Capital.**

AUREUS is an autonomous AI portfolio manager on NEAR. You fund a trading wallet, set a mandate and hard limits, and a team of AI agents researches, sizes and executes rebalances for you. The reasoning runs inside TEEs on NEAR AI Cloud, swaps route through NEAR's private shard with Confidential Intents, and you keep your own key to the wallet the whole time.

Built at NEAR HACKATHON (1 to 14 Nov 2026). Tracks: `privacy`, `defi`, `agents`, `business`.

## Live on NEAR mainnet

AUREUS is running right now with real money, in fully private custody, cycling every 30 minutes on Render with a black and white owner dashboard.

- Trading wallet: [`b241ebf3...dd6eb6`](https://nearblocks.io/address/b241ebf3f0859606527fd4799b9b4803b54d71a502007065031fe3cfaadd6eb6)
- Custody: Confidential Intents (book held in NEAR's private shard)
- Reasoning: `zai-org/GLM-5.1-FP8` in a NEAR AI Cloud TEE, signature verified on every call

**First autonomous trades (13 Nov 2026).** The book was 85% wNEAR against a 30% single-asset cap and 9% stables against a 25% floor. The Strategist called it "a compliance rebalance, not churn" and the agent executed three private swaps in one cycle:

| Swap | Size | Status |
| --- | --- | --- |
| wNEAR -> USDC | $10.80 | settled |
| wNEAR -> USDT | $8.45 | settled |
| wNEAR -> BTC | $6.04 | settled |

| Private balance | Before | After |
| --- | --- | --- |
| wNEAR | $35.84 (85%) | $10.53 (25%) |
| USDC | $3.98 | $14.71 |
| USDT | $0.00 | $8.41 |
| BTC | $2.40 | $8.41 |
| **NAV** | **$42.23** | **$42.06** |

Total cost of the rebalance, spread and price drift included: $0.17 (0.4%). None of the three swaps appears on the public chain.

## Verify it yourself

Four checks a judge can run without any of our keys.

1. **The trades are invisible onchain.** Open the [trading wallet on NEAR Blocks](https://nearblocks.io/address/b241ebf3f0859606527fd4799b9b4803b54d71a502007065031fe3cfaadd6eb6). You will find the one public deposit into the private balance ([`AhVK6f...HDnT`](https://nearblocks.io/txns/AhVK6fn3D4kEtvy31mZjpzMj75Tej12TnM4QtvT5HDnT), 9.9 NEAR), at most one daily anchor transaction whose arguments are only a Merkle root and a count, and no transaction for any of the swaps above, although the dashboard shows them executed and the private balance changed.
2. **The reasoning ran in an enclave.** In the dashboard, the Enclave page shows the model's attestation: Intel TDX and NVIDIA confidential GPU evidence, a fresh nonce, and the enclave signing address. Every cycle's Proofs entry records that the enclave's ECDSA signature over `sha256(request):sha256(response)` verified. Unverified reasoning is never acted on (`agent/src/nearai.ts`).
3. **Every decision is committed before anyone can see it.** The Proofs page lists each private decision's sha256 commitment and the onchain Merkle anchor that covers it. Disclosing a decision reveals its full reasoning and recomputes the hash up to the anchored root: `MATCH`.
4. **The AI cannot break the owner's limits.** Policy shows the mandate and caps. Try it offline: `AUREUS_SCENARIO=crash npm run demo` trips the drawdown kill switch, and `agent/test/guard.test.ts` covers caps, sizing and the stop.

The dashboard needs a read-only viewer token, provided in our submission form. It can view everything and disclose decisions, but it cannot run cycles, pause, or move money.

## The problem

An AI that manages money leaks your strategy twice:

1. **Its reasoning.** Your mandate, your full book and every thesis go to a model provider in plaintext.
2. **Its execution.** Every swap on a public chain links your wallet to your positions. Anyone can map your treasury and front-run your rebalances.

## How AUREUS works

| Layer | Mechanism | What it guarantees |
| --- | --- | --- |
| Reasoning | NEAR AI Cloud private inference (Intel TDX + NVIDIA confidential GPU) | Mandate, holdings and thesis are only decrypted inside an enclave. For every call the agent fetches a fresh-nonce attestation, then checks the enclave's ECDSA signature over `sha256(request):sha256(response)`. Unverified reasoning is never acted on. |
| Execution | NEAR Intents 1Click with `confidentiality: "advanced"` | Each swap is routed through NEAR's private shard, so the route and solver-side trail are not visible onchain. |
| Custody | Your own NEAR wallet, two keys on it | You fund a wallet with only what the agent may trade and add the agent's key. You keep your seed phrase: withdraw any time, and deleting the agent's key is an instant onchain kill switch. |
| Market view | Public market data (CoinGecko) + the agent's own price samples | The Strategist reasons over 24h / 7d / 30d trend, daily range and volume, follows an explicit framework (trend agreement, volatility sizing, regime, anti-churn) and writes a one-line reason per asset that is attached to each trade. Only public data is fetched, so nothing about the owner leaks. |
| Accounting | `src/flows.ts` | Owner deposits and withdrawals are recorded separately, so P&L measures the agent, not the owner's top-ups. |
| Limits | `src/guard.ts`, deterministic code | Max USD per trade, max USD per day, cooldown, and a drawdown kill switch checked before every trade. No LLM output can change them. |
| Audit | sha256 commitment in each transfer's memo + encrypted journal | Every trade's `ft_transfer` carries `memo: "aureus:<sha256 of the private reasoning>"`. You can later prove any single decision with `disclose`, without revealing the others. |

### What is public and what is not

| Public onchain | Private |
| --- | --- |
| The wallet sent N of token X to a 1Click deposit address, and later received the proceeds | The route through the private shard |
| A 32-byte commitment in that transfer's memo | The thesis, signals, risk concerns, quote details and limits behind it |
| | The mandate and target weights |

## Try it in 2 minutes (no keys, no funds)

Mock mode runs the full loop offline: the same agents and guard, a simulated wallet, and a rules engine standing in for the enclave model.

Requires Node 20+.

```bash
cd agent
npm install
cp aureus.config.example.json aureus.config.json
npm run demo          # cycle 1
npm run demo          # cycle 2, prices have moved
```

You should see:

- `[scout]` NAV and weights (starts at 70% USDC / 30% NEAR)
- `[strategist]` a thesis and `[risk]` review
- `[executor] USDC -> ETH $150.00 (clipped by per-trade cap)` then `onchain memo aureus:<hash>`
- cycle 2 is clipped by the $400 daily cap

Then:

```bash
npx tsx src/cli.ts status            # balances, guard state, trades: hashes only
npx tsx src/cli.ts disclose 0        # decrypt one decision, recompute its hash -> "MATCH"
AUREUS_SCENARIO=crash npm run demo   # 40% selloff -> "[guard] KILL SWITCH: drawdown ... > limit 15%"
npm run demo                         # agent stays stopped
npx tsx src/cli.ts resume            # owner restarts it; drawdown measured from current NAV
npx tsx src/cli.ts reset             # start over
```

Tests:

```bash
cd agent && npm test && npm run typecheck   # 11 tests: commitments, encryption, mandate guard, sizing, caps, kill switch, fund/withdraw baseline
```

## Run it live (NEAR mainnet)

NEAR Intents has no testnet (hackathon rule Q-007), so live mode uses mainnet. Start small. Quotes stay dry until `AUREUS_EXECUTE=true`.

1. **Create and fund a trading wallet** in any NEAR wallet app. Fund it with NEAR (and USDC if you like) that you are willing to let the agent manage. 0.5 NEAR is always kept for gas.
2. **Sign near-cli into that wallet:** `near account import-account` (mainnet, save to keychain).
3. **Generate the agent's key:** `npx tsx src/cli.ts agent-key`. It prints a line for `.env` and the `near account add-key ...` command that adds the agent's public key to your wallet. Run it.
4. **Configure:** `cp .env.example .env`, then fill `AUREUS_WALLET_ID`, `AUREUS_AGENT_KEY`, `NEAR_AI_API_KEY` (cloud.near.ai), `ONECLICK_API_KEY` (partners.near-intents.org) and `AUREUS_JOURNAL_KEY=$(openssl rand -hex 32)`. Set your limits in `aureus.config.json`.
5. **Dry run:** `npm run cycle` gives real enclave inference and real Confidential Intents quotes, and moves nothing.
6. **Trade:** `AUREUS_EXECUTE=true npm run cycle`, or `AUREUS_EXECUTE=true npx tsx src/cli.ts run 15` for a cycle every 15 minutes.

Stop it any time: `npx tsx src/cli.ts pause`, or, onchain and final, `npx tsx src/cli.ts revoke` shows the command that deletes the agent's key from your wallet.

## Fully private mode: Confidential Intents custody

Set `"custody": "confidential"` in `aureus.config.json` and the book moves inside the wallet's Confidential Intents balance, in NEAR's private shard. Every trade is then a NEP-413 intent the agent signs and 1Click settles privately: no public transaction, no visible balances, no visible trade history.

```bash
npx tsx src/cli.ts private-setup         # authorise the agent key on intents.near, sign in to the private ledger
npx tsx src/cli.ts fund wNEAR 1.5        # one public deposit into the private balance
# set "custody": "confidential" in aureus.config.json
npm run cycle                            # private quotes; AUREUS_EXECUTE=true to trade
npx tsx src/cli.ts private-balances      # readable only with a session your wallet key signs for
npx tsx src/cli.ts history               # private trade history (1Click: invite-only for now)
npx tsx src/cli.ts withdraw wNEAR all    # one public payout back to the wallet
```

| Public | Private |
| --- | --- |
| The one-time `fund` deposit and any `withdraw` | Every trade, every balance, the history, the route, and the reasoning |

Nothing is published per trade. Instead, `anchor` publishes one Merkle root over the private decisions made since the last anchor, in a single read-only transaction on `wrap.near` whose arguments carry only the root and a count. `disclose <n>` then proves one private decision against that onchain root without revealing any other.

```bash
npx tsx src/cli.ts anchor                # one public tx: root + count, nothing else
npx tsx src/cli.ts disclose 2            # memo -> its hash -> Merkle root -> onchain tx: MATCH
```

## Verify the enclave yourself

`npx tsx src/cli.ts attest` fetches a fresh attestation report for the model, saves it, and prints the enclave signing address. Check the report with the public TEE explorer (https://proof.t16z.com) or NEAR AI's open-source verifier (https://github.com/nearai/nearai-cloud-verifier). The signing address must match the `signingAddress` in your disclosed trades.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Model provider or host reads the strategy | Inference only in attested TEEs; signature chain verified per call |
| Prompt injection or bad model output | Risk officer can only lower risk; deterministic mandate guard; USD caps and drawdown stop in `guard.ts` |
| Agent key stolen or agent bug | Exposure is limited to the trading wallet, never your main wallet. Delete the agent's key from the wallet and it is locked out instantly |
| Front-running and route tracking | Confidential Intents private shard |
| Treasury and position tracking | Confidential custody: balances and trades live in the private shard |
| "Trust me" reasoning | Wallet mode: commitment onchain before the swap settles. Private mode: Merkle anchor. `disclose` proves either |

Known limit: the caps live in the agent's code, so they protect against bad decisions, not against someone who steals the agent's key. For that, see the hardened mode below.

### Hardened mode (optional): onchain policy vault

`contracts/aureus-vault/` is a Rust contract (16 unit tests, `cargo test`) that holds funds and enforces the same caps onchain. There the agent only gets a function-call key for two methods and cannot withdraw. `scripts/deploy-vault.sh` deploys it. The default wallet mode is simpler to set up and keeps the strategy just as private; the vault is for users who want limits even a stolen agent key cannot bypass.

## Roadmap

- Oracle-priced NAV for the drawdown switch.
- Several owners per deployment, each with their own private book.
- Backtests of the Strategist's framework against historical prices.

## Repository

agent/src/agents/ scout, strategist, risk, allocator, executor
agent/src/guard.ts owner limits and kill switch
agent/src/market.ts public market context for the Strategist
agent/src/flows.ts owner deposits and withdrawals, P&L baseline
agent/src/server.ts dashboard API, autonomous loop, owner and viewer roles
agent/src/wallet.ts trading wallet: wrap, transfer with commitment memo, anchors
agent/src/nearai.ts NEAR AI Cloud client, attestation and signature verification
agent/src/intents.ts 1Click client with Confidential Intents
agent/src/confidential.ts private balance custody: NEP-413 signing, session auth, balances
agent/src/journal.ts AES-256-GCM decision journal and Merkle anchors
contracts/aureus-vault/ optional onchain policy vault


## Hackathon disclosure

- All code was written during NEAR HACKATHON (from 4 Nov 2026). No pre-hackathon code.
- Libraries: near-api-js, @defuse-protocol/intents-sdk (versioned nonces, NEP-413 hashing), ethers (signature recovery), zod, dotenv, tsx, TypeScript; near-sdk, hex for the optional contract. Built with help from AI coding tools.
- Integrations: NEAR AI Cloud, NEAR Intents 1Click (Confidential Intents), NEAR accounts and access keys, CoinGecko public market data. Dashboard built with Lovable.

## License

MIT
