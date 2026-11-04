/**
 * Private decision journal. Each entry holds the full memo behind a trade,
 * AES-256-GCM encrypted at rest. Onchain there is only sha256(memo), in the
 * memo field of the trade's ft_transfer. `disclose` decrypts one entry and
 * proves it against that transaction.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";

export interface JournalEntry {
  n: number;
  at: string;
  /** "tx": public NEAR transaction (wallet custody). "intent": private intent hash (confidential custody). */
  kind?: "tx" | "intent";
  /** NEAR tx hash, or the intent hash for private trades (older entries only have txHash). */
  txHash: string;
  commitment: string;
  sealed: string;
}

function key(): string {
  if (config.journalKeyHex) return config.journalKeyHex;
  if (config.mode === "live") throw new Error("missing env AUREUS_JOURNAL_KEY (openssl rand -hex 32)");
  const f = join(config.dataDir, "journal.key");
  mkdirSync(config.dataDir, { recursive: true });
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(f, "utf8").trim();
}

const file = () => join(config.dataDir, "journal.jsonl");

export function entries(): JournalEntry[] {
  if (!existsSync(file())) return [];
  return readFileSync(file(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function record(txHash: string, commitment: string, memoCanonical: string, kind: "tx" | "intent" = "tx") {
  mkdirSync(config.dataDir, { recursive: true });
  const e: JournalEntry = { n: entries().length, at: new Date().toISOString(), kind, txHash, commitment, sealed: encrypt(key(), memoCanonical) };
  appendFileSync(file(), JSON.stringify(e) + "\n");
}

// ------------------------------------------------------------------- anchors
// Private trades leave nothing onchain. `anchor` publishes one Merkle root over the
// commitments made since the last anchor, so each private decision can later be proven
// against the public chain, while observers learn only that "some decisions happened".

export interface Anchor { at: string; txHash: string; root: string; leaves: string[] }
const anchorFile = () => join(config.dataDir, "anchors.jsonl");

export function anchors(): Anchor[] {
  if (!existsSync(anchorFile())) return [];
  return readFileSync(anchorFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function unanchored(): JournalEntry[] {
  const done = new Set(anchors().flatMap((a) => a.leaves));
  return entries().filter((e) => e.kind === "intent" && !done.has(e.commitment));
}
export function recordAnchor(a: Anchor) {
  mkdirSync(config.dataDir, { recursive: true });
  appendFileSync(anchorFile(), JSON.stringify(a) + "\n");
}
export const anchorFor = (commitment: string) => anchors().find((a) => a.leaves.includes(commitment)) ?? null;

/** Open by decision number or by transaction hash. */
export function open(ref: string): { entry: JournalEntry; memo: string } | null {
  const entry = entries().find((e) => String(e.n) === ref || e.txHash === ref);
  return entry ? { entry, memo: decrypt(key(), entry.sealed) } : null;
}
