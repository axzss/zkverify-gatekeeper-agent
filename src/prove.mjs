// prove.mjs — Groth16 proof generation for the Proof Gatekeeper circuit.
// Uses the platform's own artifacts (gatekeeper.wasm + gatekeeper_final.zkey)
// with snarkjs. The proof is generated LOCALLY and verified against the
// platform's verification key before it is returned.
//
// Circuit inputs (13, discovered by probing the WASM — all are public
// signals, nPublic = 13):
//   registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
//   currentBlock, recipient, conditionRecipient, amount, maxTransfer,
//   decision, taskId, salt
//
// ENCODING (assumptions — single place to fix if practice-mode feedback
// shows the platform uses a different canonical encoding):
//   - hex addresses (recipient/conditionRecipient): BigInt(hex), 160-bit.
//   - decimal numbers: BigInt(decimal string).
//   - vk hashes (registeredVkHash/proofVkHash): BigInt(hex vk) mod BN128 prime.
//     (The task shows vks as 0x-prefixed hex; a 256-bit value may exceed the
//     ~254-bit prime, so mod p is required.)
//   - taskId: SHA3-256 of the task_id string, mod prime.
//     (task_id is a string like "gk_24_9d1"; the platform's canonical
//     encoding is NOT published — this is the open question for practice.)
//   - salt: env GATEKEEPER_SALT, default "0". Purpose not published; if the
//     dashboard/practice reveals a per-agent salt, set it in .env.
//   - decision: "1" = APPROVE, "0" = REJECT.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import * as snarkjs from "snarkjs";

// BN128 scalar field prime (snarkjs/bn128).
export const BN128_PRIME =
  BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

export function fieldFromHex(hex) {
  if (typeof hex !== "string") throw new Error("fieldFromHex: not a string");
  const s = hex.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(s)) throw new Error(`fieldFromHex: bad hex ${hex}`);
  return (BigInt(s) % BN128_PRIME).toString(10);
}

export function fieldFromDecimal(v) {
  const b = typeof v === "bigint" ? v : BigInt(String(v).trim());
  if (b < 0n) throw new Error("fieldFromDecimal: negative");
  return (b % BN128_PRIME).toString(10);
}

export function fieldFromTaskId(taskId) {
  const h = createHash("sha3-256").update(String(taskId), "utf8").digest("hex");
  return (BigInt("0x" + h) % BN128_PRIME).toString(10);
}

// Build the 13 circuit inputs from a task + decision.
// input: the task's `input` object. decision: "APPROVE" | "REJECT".
// salt: string/number (default "0").
export function buildCircuitInputs(input, decision, salt = "0") {
  return {
    registeredVkHash: fieldFromHex(input.registered_vk),
    proofVkHash: fieldFromHex(input.proof_vk),
    minimum: fieldFromDecimal(input.minimum),
    publicBalance: fieldFromDecimal(input.public_balance),
    expiryBlock: fieldFromDecimal(input.expiry_block),
    currentBlock: fieldFromDecimal(input.current_block),
    recipient: fieldFromHex(input.recipient),
    conditionRecipient: fieldFromHex(input.condition_recipient),
    amount: fieldFromDecimal(input.amount),
    maxTransfer: fieldFromDecimal(input.max_transfer),
    decision: decision === "APPROVE" ? "1" : "0",
    taskId: fieldFromTaskId(input.task_id ?? ""),
    salt: fieldFromDecimal(salt),
  };
}

// Generate a Groth16 proof. Returns { proof, publicSignals }.
// Throws on failure (caller must fail closed, not crash the task).
export async function generateProof(circuitInputs, paths) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    paths.wasm,
    paths.zkey
  );
  // Local sanity check against the platform verification key.
  const vk = JSON.parse(readFileSync(paths.vk, "utf8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error("local proof verification failed");
  return { proof, publicSignals };
}

// Same as generateProof but with a hard timeout (ms). Rejects on timeout.
export function generateProofTimed(circuitInputs, paths, timeoutMs = 30000) {
  return Promise.race([
    generateProof(circuitInputs, paths),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("proof-generation-timeout")), timeoutMs)
    ),
  ]);
}
