/**
 * Private inference on NEAR AI Cloud.
 *
 * Every model call runs inside a TEE (Intel TDX + NVIDIA confidential GPU).
 * For each call we keep a proof chain:
 *   1. attestation report for the model (fresh nonce)  -> binds a signing key to the enclave
 *   2. per-chat signature of "sha256(request):sha256(response)" from that key
 *   3. we recompute both hashes locally and recover the signer with ECDSA
 * If the signer matches the attested key, the reasoning provably ran in the enclave
 * on exactly the prompt we sent. Only sha256(attestation) goes onchain.
 */
import { randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";
import type { z } from "zod";
import { config } from "./config.ts";
import { canonical, sha256Hex } from "./crypto.ts";
import { mockLlm } from "./mock.ts";

export interface InferenceProof {
  model: string;
  chatId: string;
  attestationHash: string;
  signingAddress: string | null;
  signatureVerified: boolean;
  mock: boolean;
}

interface Attestation {
  hash: string;
  signingAddress: string | null;
}

let cachedAttestation: Attestation | null = null;

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${config.nearAi.baseURL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.nearAi.apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`NEAR AI ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

/** Look for the enclave signing address anywhere in the report (field names vary by model host). */
function findSigningAddress(report: unknown): string | null {
  const s = JSON.stringify(report);
  const m = s.match(/"signing_address"\s*:\s*"(0x[0-9a-fA-F]{40})"/);
  return m ? m[1].toLowerCase() : null;
}

/** Fetch a fresh attestation report for the model, bound to a random nonce. */
export async function attestationReport(): Promise<{ nonce: string; report: unknown }> {
  const nonce = randomBytes(32).toString("hex");
  const q = new URLSearchParams({ model: config.nearAi.model, nonce, signing_algo: "ecdsa" });
  return { nonce, report: await (await api(`/attestation/report?${q}`)).json() };
}

export async function attest(): Promise<Attestation> {
  if (cachedAttestation) return cachedAttestation;
  const { nonce, report } = await attestationReport();
  const text = JSON.stringify(report);
  if (!text.includes(nonce)) throw new Error("attestation report does not echo our nonce (stale or replayed)");
  if (!/intel_quote|nvidia_payload|tdx/i.test(text)) throw new Error("attestation report has no TEE quote");
  cachedAttestation = { hash: sha256Hex(canonical(report)), signingAddress: findSigningAddress(report) };
  return cachedAttestation;
}

async function verifyChat(chatId: string, requestBody: string, responseBody: string, att: Attestation) {
  const q = new URLSearchParams({ model: config.nearAi.model, signing_algo: "ecdsa" });
  const sig = (await (await api(`/signature/${encodeURIComponent(chatId)}?${q}`)).json()) as {
    text: string;
    signature: string;
    signing_address?: string;
  };
  const expected = `${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  const recovered = verifyMessage(sig.text, sig.signature).toLowerCase();
  const signerOk = !att.signingAddress || recovered === att.signingAddress;
  const textOk = sig.text === expected;
  return { verified: signerOk && textOk && (!sig.signing_address || sig.signing_address.toLowerCase() === recovered), recovered };
}

/** Ask the enclave model for JSON matching `schema`. Returns data plus its proof. */
export async function privateJson<T>(
  role: string,
  system: string,
  user: unknown,
  schema: z.ZodType<T>,
): Promise<{ data: T; proof: InferenceProof }> {
  if (config.mode === "mock") {
    const data = schema.parse(mockLlm(role, user));
    return {
      data,
      proof: {
        model: "mock",
        chatId: `mock-${role}`,
        attestationHash: sha256Hex("aureus-mock-attestation"),
        signingAddress: null,
        signatureVerified: false,
        mock: true,
      },
    };
  }

  const att = await attest();
  const requestBody = JSON.stringify({
    model: config.nearAi.model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${system}\nReply with a single JSON object only.` },
      { role: "user", content: JSON.stringify(user) },
    ],
  });
  const res = await api("/chat/completions", { method: "POST", body: requestBody });
  const responseBody = await res.text();
  const body = JSON.parse(responseBody);
  const content: string = body.choices?.[0]?.message?.content ?? "";
  const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  const data = schema.parse(JSON.parse(json));

  let verified = false;
  let signer: string | null = att.signingAddress;
  try {
    const v = await verifyChat(body.id, requestBody, responseBody, att);
    verified = v.verified;
    signer = v.recovered;
  } catch (e) {
    if (config.nearAi.requireAttestation) throw e;
  }
  if (config.nearAi.requireAttestation && !verified) {
    throw new Error(`${role}: enclave signature did not verify; refusing to act on unverified reasoning`);
  }
  return {
    data,
    proof: { model: config.nearAi.model, chatId: body.id, attestationHash: att.hash, signingAddress: signer, signatureVerified: verified, mock: false },
  };
}
