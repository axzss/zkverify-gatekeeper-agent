// sign.mjs — HMAC-SHA256 sign/verify for x-agent-games-signature.
// Inbound: verify the header against the RAW request body BEFORE parsing.
// Outbound: sign the RAW response body and set the same header.
// Uses timingSafeEqual. If no secret is configured (dev / pre-registration),
// verification is skipped but clearly flagged — never silently enforced
// with a placeholder (the build guide forbids local placeholder secrets).

import { createHmac, timingSafeEqual } from "crypto";

export function hmacHex(secret, rawBody) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function parseSigHeader(header) {
  if (!header || typeof header !== "string") return null;
  // Accept "sha256=<hex>" or a bare hex value.
  const m = header.trim().match(/^(?:sha256=)?([0-9a-fA-F]{64})$/);
  return m ? m[1].toLowerCase() : null;
}

export function verifySignature(secret, rawBody, header) {
  if (!secret) return { ok: false, reason: "no-secret-configured" };
  const sig = parseSigHeader(header);
  if (!sig) return { ok: false, reason: "missing-or-malformed-signature" };
  const expected = hmacHex(secret, rawBody);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return { ok: false, reason: "signature-mismatch" };
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "signature-mismatch" };
}

export function signBody(secret, rawBody) {
  return hmacHex(secret, rawBody);
}
