// test.mjs — Local test harness: 7 sample tasks (1 per trap variety).
// Spawns the server on a test port with a test HMAC secret, POSTs signed
// envelopes, and checks decision + reason_code (+ proof presence/validity).
// Usage: node src/test.mjs [baseUrl]   (default: spawns server on :3456)
// Exit 0 = all pass, 1 = any fail.

import { spawn } from "child_process";
import { createHmac } from "crypto";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_SECRET = "test-secret-do-not-use-in-prod";
const PORT = 3456;

const BASE_INPUT = {
  registered_vk: "0x7d3a11111111111111111111111111111111111111111111111111111111f291",
  proof_vk: "0x7d3a11111111111111111111111111111111111111111111111111111111f291",
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 19842201,
  current_block: 19832000,
  recipient: "0xDe4200000000000000000000000000000000009f01",
  condition_recipient: "0xDe4200000000000000000000000000000000009f01",
  amount: "500",
  max_transfer: "1000",
  proof_tx: "0xa4c11111111111111111111111111111111111111111111111111111111118ff1",
};

function task(id, mutate) {
  const input = { ...BASE_INPUT, ...(mutate || {}) };
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: id,
    mode: "practice",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input,
  };
}

const CASES = [
  { name: "VALID_CONDITION", env: task("gk_test_valid", {}), expect: ["APPROVE", "VALID_CONDITION"], proof: true },
  { name: "VK_SUBSTITUTION", env: task("gk_test_vk", { proof_vk: "0xa4c12222222222222222222222222222222222222222222222222222222222b8ff" }), expect: ["REJECT", "VK_SUBSTITUTION"], proof: true },
  { name: "THRESHOLD_MISMATCH", env: task("gk_test_thr", { public_balance: "500" }), expect: ["REJECT", "THRESHOLD_MISMATCH"], proof: true },
  { name: "RECIPIENT_MISMATCH", env: task("gk_test_rcp", { recipient: "0xBeef00000000000000000000000000000000000001" }), expect: ["REJECT", "RECIPIENT_MISMATCH"], proof: true },
  { name: "AMOUNT_OVERFLOW", env: task("gk_test_amt", { amount: "5000" }), expect: ["REJECT", "AMOUNT_OVERFLOW"], proof: true },
  { name: "EXPIRED_CONDITION", env: task("gk_test_exp", { current_block: 19850000 }), expect: ["REJECT", "EXPIRED_CONDITION"], proof: true },
  // Re-send the VALID task's proof_tx -> must be caught as reused.
  { name: "PROOF_REUSED", env: task("gk_test_reuse", {}), expect: ["REJECT", "PROOF_REUSED"], proof: false },
];

function sign(raw) {
  return createHmac("sha256", TEST_SECRET).update(raw).digest("hex");
}

async function postTask(base, env) {
  const raw = JSON.stringify(env);
  const res = await fetch(base + "/task", {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": sign(raw) },
    body: raw,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, sig: res.headers.get("x-agent-games-signature") };
}

async function main() {
  let base = process.argv[2];
  let child = null;
  if (!base) {
    base = `http://127.0.0.1:${PORT}`;
    child = spawn("node", ["src/server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: TEST_SECRET, GATEKEEPER_SALT: "0" },
      stdio: "ignore",
    });
    // Wait for /health.
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(base + "/health");
        if (r.ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  let pass = 0, fail = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    let out;
    try {
      out = await postTask(base, c.env);
    } catch (e) {
      console.log(`[FAIL] ${c.name}: fetch error ${e.message}`);
      fail++;
      continue;
    }
    const ms = Date.now() - t0;
    const got = [out.body?.decision, out.body?.reason_code];
    const okDecision = got[0] === c.expect[0] && got[1] === c.expect[1];
    const hasProof = !!out.body?.proof && Array.isArray(out.body?.public_signals);
    const okProof = c.proof ? hasProof : !hasProof;
    const okSig = !!out.sig;
    const ok = okDecision && okProof && okSig && out.status === 200;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name}: got ${got[0]}/${got[1]} (want ${c.expect[0]}/${c.expect[1]}) proof=${hasProof ? "yes" : "no"} signed=${okSig} ${ms}ms status=${out.status}`);
    if (!ok && out.body) console.log("       body:", JSON.stringify(out.body).slice(0, 300));
    ok ? pass++ : fail++;
  }

  // Health + preflight smoke checks.
  try {
    const h = await fetch(base + "/health").then((r) => r.json());
    console.log(`[${h?.ok ? "PASS" : "FAIL"}] GET /health: ok=${h?.ok} seen_count=${h?.seen_count}`);
    h?.ok ? pass++ : fail++;
    const p = await fetch(base + "/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const pj = await p.json().catch(() => ({}));
    const pok = pj?.ok === true && pj?.protocolVersion === "v1";
    console.log(`[${pok ? "PASS" : "FAIL"}] POST /preflight: ${JSON.stringify(pj)}`);
    pok ? pass++ : fail++;
  } catch (e) {
    console.log(`[FAIL] health/preflight: ${e.message}`);
    fail += 2;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (child) child.kill();
  process.exit(fail ? 1 : 0);
}

main();
