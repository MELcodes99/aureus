import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, decrypt, encrypt, sha256Hex } from "../src/crypto.ts";
import { enforceMandate } from "../src/agents/risk.ts";
import { allocate } from "../src/agents/allocator.ts";
import { toUnits, type Snapshot } from "../src/agents/scout.ts";
import { config } from "../src/config.ts";

const syms = ["USDC", "wNEAR", "ETH"];

test("canonical JSON is key-order independent, so commitments are reproducible", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(sha256Hex(canonical({ x: 1, y: 2 })), sha256Hex('{"x":1,"y":2}'));
});

test("journal encryption round-trips and rejects tampering", () => {
  const k = "11".repeat(32);
  const sealed = encrypt(k, "private thesis");
  assert.equal(decrypt(k, sealed), "private thesis");
  const raw = Buffer.from(sealed, "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decrypt(k, raw.toString("base64")));
});

test("mandate guard caps single assets and enforces the stable floor", () => {
  const w = enforceMandate({ USDC: 0, wNEAR: 0.9, ETH: 0.1 }, syms, ["USDC"]);
  assert.ok(w.wNEAR <= config.mandate.maxSingleAssetWeight + 1e-9);
  assert.ok(w.USDC >= config.mandate.minStableWeight - 1e-9);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

test("mandate guard sends an all-zero proposal to stables", () => {
  assert.deepEqual(enforceMandate({}, syms, ["USDC"]), { USDC: 1, wNEAR: 0, ETH: 0 });
});

test("allocator sizes trades to the guard caps", () => {
  const usdc = { symbol: "USDC", contract: "usdc.near", decimals: 6, stable: true, optional: false, assetId: "nep141:usdc.near", price: 1 };
  const near = { symbol: "wNEAR", contract: "wrap.near", decimals: 24, stable: false, optional: false, assetId: "nep141:wrap.near", price: 2 };
  const snap: Snapshot = {
    at: "", assets: [usdc, near], market: [], navUsd: 1000,
    holdings: [
      { asset: usdc, units: toUnits(1000, 6), usd: 1000, weight: 1 },
      { asset: near, units: 0n, usd: 0, weight: 0 },
    ],
  };
  const { trades } = allocate(snap, { USDC: 0.5, wNEAR: 0.5 }, 1, { maxTradeUsd: 100, remainingTodayUsd: 150 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].amount, toUnits(100, 6));
  assert.equal(trades[0].clippedBy, "per-trade cap");
});

test("allocator does nothing inside the rebalance threshold", () => {
  const usdc = { symbol: "USDC", contract: "usdc.near", decimals: 6, stable: true, optional: false, assetId: "a", price: 1 };
  const near = { symbol: "wNEAR", contract: "wrap.near", decimals: 24, stable: false, optional: false, assetId: "b", price: 2 };
  const snap: Snapshot = {
    at: "", assets: [usdc, near], market: [], navUsd: 1000,
    holdings: [
      { asset: usdc, units: toUnits(520, 6), usd: 520, weight: 0.52 },
      { asset: near, units: toUnits(240, 24), usd: 480, weight: 0.48 },
    ],
  };
  const { trades } = allocate(snap, { USDC: 0.5, wNEAR: 0.5 }, 1, { maxTradeUsd: 1000, remainingTodayUsd: 1000 });
  assert.equal(trades.length, 0);
});

test("allocator clips to what is left of today's budget", () => {
  const usdc = { symbol: "USDC", contract: "usdc.near", decimals: 6, stable: true, optional: false, assetId: "a", price: 1 };
  const near = { symbol: "wNEAR", contract: "wrap.near", decimals: 24, stable: false, optional: false, assetId: "b", price: 2 };
  const snap: Snapshot = {
    at: "", assets: [usdc, near], market: [], navUsd: 1000,
    holdings: [
      { asset: usdc, units: toUnits(1000, 6), usd: 1000, weight: 1 },
      { asset: near, units: 0n, usd: 0, weight: 0 },
    ],
  };
  const { trades } = allocate(snap, { USDC: 0.5, wNEAR: 0.5 }, 1, { maxTradeUsd: 100, remainingTodayUsd: 30 });
  assert.equal(trades[0].usd, 30);
  assert.equal(trades[0].clippedBy, "daily cap");
});
