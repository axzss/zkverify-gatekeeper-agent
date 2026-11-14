// decide.mjs — Pure, deterministic Proof Gatekeeper decision logic.
// No I/O, no network, no secrets. The ONLY state it touches is the
// seen-set (proof_tx values previously ACCEPTED), passed in as a Set-like.
//
// Checks (in order — first failure wins, since a task normally carries
// exactly one trap):
//   1. VK_SUBSTITUTION   proof_vk !== registered_vk
//   2. THRESHOLD_MISMATCH public_balance < minimum
//   3. RECIPIENT_MISMATCH recipient !== condition_recipient
//   4. AMOUNT_OVERFLOW    amount > max_transfer
//   5. EXPIRED_CONDITION  current_block > expiry_block
//   6. PROOF_REUSED       proof_tx already in seen-set (previously accepted)
//   7. (on-chain proof check lives in the server layer — Kurier/zkVerifyJS;
//      it is defence-in-depth, not one of the 7 scored traps.)
// If every check passes -> APPROVE / VALID_CONDITION.
// Fail closed: any malformed/missing field -> REJECT with INVALID_TASK.

export const REASON = {
  VALID: "VALID_CONDITION",
  VK: "VK_SUBSTITUTION",
  THRESHOLD: "THRESHOLD_MISMATCH",
  REUSED: "PROOF_REUSED",
  EXPIRED: "EXPIRED_CONDITION",
  RECIPIENT: "RECIPIENT_MISMATCH",
  AMOUNT: "AMOUNT_OVERFLOW",
  INVALID: "INVALID_TASK",
};

function normHex(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(s)) return null;
  return s.replace(/^0x0+/, "0x") || "0x0";
}

function toBig(v) {
  // Accept decimal strings ("1460"), hex strings ("0x..."), or numbers.
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "bigint") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  }
  return null;
}

// input: the task's `input` object (fields per the event page sample).
// seen: a Set (or Set-like with .has) of proof_tx values previously ACCEPTED.
// Returns { decision: "APPROVE"|"REJECT", reason_code }.
export function decide(input, seen) {
  if (!input || typeof input !== "object") {
    return { decision: "REJECT", reason_code: REASON.INVALID };
  }
  const {
    registered_vk, proof_vk, minimum, public_balance,
    expiry_block, current_block, recipient, condition_recipient,
    amount, max_transfer, proof_tx,
  } = input;

  // --- structural validation (fail closed) ---
  const regVk = normHex(registered_vk);
  const prfVk = normHex(proof_vk);
  const min = toBig(minimum);
  const bal = toBig(public_balance);
  const exp = toBig(expiry_block);
  const cur = toBig(current_block);
  const rcp = normHex(recipient);
  const crp = normHex(condition_recipient);
  const amt = toBig(amount);
  const mx = toBig(max_transfer);
  const ptx = typeof proof_tx === "string" && proof_tx.trim() !== "" ? proof_tx.trim() : null;
  if (
    regVk === null || prfVk === null || min === null || bal === null ||
    exp === null || cur === null || rcp === null || crp === null ||
    amt === null || mx === null || ptx === null
  ) {
    return { decision: "REJECT", reason_code: REASON.INVALID };
  }

  // 1. VK substitution
  if (regVk !== prfVk) return { decision: "REJECT", reason_code: REASON.VK };
  // 2. Threshold mismatch
  if (bal < min) return { decision: "REJECT", reason_code: REASON.THRESHOLD };
  // 3. Recipient mismatch
  if (rcp !== crp) return { decision: "REJECT", reason_code: REASON.RECIPIENT };
  // 4. Amount overflow
  if (amt > mx) return { decision: "REJECT", reason_code: REASON.AMOUNT };
  // 5. Expired condition
  if (cur > exp) return { decision: "REJECT", reason_code: REASON.EXPIRED };
  // 6. Proof reused (previously accepted)
  if (seen && seen.has(ptx)) return { decision: "REJECT", reason_code: REASON.REUSED };

  return { decision: "APPROVE", reason_code: REASON.VALID };
}

export { normHex, toBig };
