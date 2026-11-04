import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Canonical JSON (sorted keys) so a memo hashes the same on every machine.
 * The trade transfer carries sha256(canonical(memo)) in its memo; `disclose` checks the same bytes.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const newSalt = () => randomBytes(16).toString("hex");

/** AES-256-GCM. The private journal never leaves the owner's machine in plaintext. */
export function encrypt(keyHex: string, plaintext: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("AUREUS_JOURNAL_KEY must be 32 bytes hex (openssl rand -hex 32)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decrypt(keyHex: string, blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/**
 * Merkle root over hex commitments (sha256 of left||right, last leaf duplicated on odd levels).
 * Publishing one root proves every commitment under it existed at that time, revealing none of them.
 */
export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) throw new Error("no leaves");
  let level = leaves.map((l) => l.toLowerCase());
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}
