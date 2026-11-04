import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AUREUS_DATA_DIR = mkdtempSync(join(tmpdir(), "aureus-guard-"));
const guard = await import("../src/guard.ts");
const { config } = await import("../src/config.ts");

beforeEach(() => rmSync(join(config.dataDir, "guard.json"), { force: true }));

test("per-trade and daily caps", () => {
  assert.throws(() => guard.check(config.limits.maxTradeUsd + 1), /per-trade cap/);
  guard.recordTrade(config.limits.maxDailyUsd - 10);
  assert.throws(() => guard.check(20), /daily cap/);
  assert.doesNotThrow(() => guard.check(5));
});

test("drawdown trips the kill switch, resume resets the high-water mark", () => {
  guard.recordNav(1000);
  const s = guard.recordNav(1000 * (1 - (config.limits.maxDrawdownPct + 1) / 100));
  assert.equal(s.paused, true);
  assert.throws(() => guard.check(1), /paused/);
  guard.resume();
  const after = guard.status();
  assert.equal(after.paused, false);
  assert.equal(after.drawdownPct, 0);
});

test("owner pause blocks trades", () => {
  guard.pause("test");
  assert.throws(() => guard.check(1), /paused \(test\)/);
});

test("fund and withdraw shift the baseline instead of counting as drawdown", () => {
  guard.recordNav(1000);
  guard.adjustForFlow(-600); // owner withdrew $600
  const s = guard.recordNav(400);
  assert.equal(s.paused, false);
  assert.equal(s.drawdownPct, 0);
});
