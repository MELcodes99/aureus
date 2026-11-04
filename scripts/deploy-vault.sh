#!/usr/bin/env bash
# Deploy the AUREUS vault to NEAR mainnet and lock the agent down to two methods.
# Requires: cargo-near, near-cli-rs (`near`), accounts already created in a NEAR wallet.
# Check flags against `near --help` for your CLI version before running.
set -euo pipefail

: "${OWNER:?set OWNER, e.g. mel.near}"
: "${VAULT:?set VAULT, e.g. aureus.mel.near (sub-account of OWNER)}"
: "${AGENT:?set AGENT, e.g. agent.aureus.mel.near (a separate account the AI controls)}"
NET="${NET:-mainnet}"
USDC="17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"

echo "1/6 build wasm"
(cd contracts/aureus-vault && cargo near build non-reproducible-wasm)
WASM=contracts/aureus-vault/target/near/aureus_vault.wasm

echo "2/6 deploy + init (10% drawdown kill switch, 5 min cooldown)"
near contract deploy "$VAULT" use-file "$WASM" \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"agent\":\"$AGENT\",\"policy\":{\"max_drawdown_bps\":1000,\"cooldown_secs\":300}}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NET" sign-with-keychain send

echo "3/6 register vault storage on tokens it will hold"
for T in "$USDC" wrap.near; do
  near contract call-function as-transaction "$T" storage_deposit json-args "{\"account_id\":\"$VAULT\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0.0125 NEAR' sign-as "$OWNER" network-config "$NET" sign-with-keychain send
done

echo "4/6 owner sets per-token caps (start tiny: 5 USDC/trade, 20 USDC/day; 2 NEAR/trade, 8 NEAR/day)"
near contract call-function as-transaction "$VAULT" set_token_limit \
  json-args "{\"token\":\"$USDC\",\"limit\":{\"max_per_trade\":\"5000000\",\"max_per_day\":\"20000000\"}}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NET" sign-with-keychain send
near contract call-function as-transaction "$VAULT" set_token_limit \
  json-args '{"token":"wrap.near","limit":{"max_per_trade":"2000000000000000000000000","max_per_day":"8000000000000000000000000"}}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NET" sign-with-keychain send

echo "5/6 give the agent a function-call key that can ONLY call execute_trade and report_nav on the vault"
near account add-key "$AGENT" grant-function-call-access \
  --allowance '0.5 NEAR' --contract-account-id "$VAULT" --function-names 'execute_trade, report_nav' \
  autogenerate-new-keypair print-to-terminal network-config "$NET" sign-with-keychain send
echo "   -> put the printed private key in agent/.env as AUREUS_AGENT_KEY"

echo "6/6 fund the vault (owner sends 20 USDC with ft_transfer_call)"
near contract call-function as-transaction "$USDC" ft_transfer_call \
  json-args "{\"receiver_id\":\"$VAULT\",\"amount\":\"20000000\",\"msg\":\"\"}" \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config "$NET" sign-with-keychain send

echo "done. next: cd agent && AUREUS_MODE=live npm run cycle   (dry quotes until AUREUS_EXECUTE=true)"
