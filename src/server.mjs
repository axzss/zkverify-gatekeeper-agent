// server.mjs — Proof Gatekeeper agent endpoint (Node 22 stdlib only).
// Routes:
//   GET  /health     -> { ok, protocolVersion, service, uptime, seenCount }
//   GET  /           -> service info (JSON)
//   POST /preflight  -> { ok: true, protocolVersion: "v1" } (signed response)
//   POST /task       -> task handler (also POST /agent as an alias)
// Task flow (60s hard deadline; internal budget ~55s):
//   1. read raw body -> 2. verify HMAC (if secret set) BEFORE parsing
//   3. parse envelope -> 4. decide() (7 checks, fail closed)
//   5. APPROVE -> record proof_tx in seen-set
//   6. generate Groth16 proof (skipped for PROOF_REUSED — no proof exists
//      for a reused reference) -> 7. submit to Kurier IN THE BACKGROUND
//      (fire-and-forget — awaiting submit+poll cost ~20s and blew the
//      platform's tighter practice deadline on 15 Nov) -> 8. sign
//      response + reply immediately.
// A correct decision is ALWAYS returned, even if proof generation or
// Kurier fails — a missing proof costs -2, a timeout costs -2 AND the
// decision, so never let a slow proof step eat the whole deadline.

import { createServer } from "http";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { decide, REASON } from "./decide.mjs";
import { SeenSet } from "./seen.mjs";
import { verifySignature, signBody } from "./sign.mjs";
import { buildCircuitInputs, generateProofTimed } from "./prove.mjs";
import { submitProof, pollUntilFinalized, GATEKEEPER_VK_HASH } from "./kurier.mjs";

// Warm up the prover once at boot (first fullProve includes WASM
// instantiation and is the slowest; subsequent proves are ~1-2s).
// Runs in the background — never blocks listening.
async function warmupProver() {
  try {
    const dummy = buildCircuitInputs({
      registered_vk: "0x7d3a00000000000000000000000000000000000000000000000000000000f291",
      proof_vk: "0x7d3a00000000000000000000000000000000000000000000000000000000f291",
      minimum: "1000", public_balance: "1460",
      expiry_block: "19842201", current_block: "19832000",
      recipient: "0xDe4200000000000000000000000000000000009f01",
      condition_recipient: "0xDe4200000000000000000000000000000000009f01",
      amount: "500", max_transfer: "1000", task_id: "warmup",
    }, "APPROVE", CFG.salt);
    await generateProofTimed(dummy, CFG.circuit, 60000);
    log({ event: "prover-warmup", status: "ok" });
  } catch (e) {
    log({ event: "prover-warmup", status: "failed", error: String(e?.message || e).slice(0, 120) });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Node 22: load .env into process.env (no dependency).
try { process.loadEnvFile(resolve(ROOT, ".env")); } catch { /* no .env yet */ }

const CFG = {
  port: Number(process.env.PORT || 3000),
  hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || "",
  kurierKey: process.env.KURIER_API_KEY || "",
  kurierNetwork: process.env.KURIER_NETWORK || "mainnet",
  salt: process.env.GATEKEEPER_SALT || "0",
  seenFile: process.env.SEEN_FILE || resolve(ROOT, "data", "seen.json"),
  logFile: process.env.LOG_FILE || resolve(ROOT, "logs", "tasks.log"),
  proofTimeoutMs: Number(process.env.PROOF_TIMEOUT_MS || 30000),
  kurierPollTimeoutMs: Number(process.env.KURIER_POLL_TIMEOUT_MS || 20000),
  circuit: {
    wasm: resolve(ROOT, "circuits", "gatekeeper.wasm"),
    zkey: resolve(ROOT, "circuits", "gatekeeper_final.zkey"),
    vk: resolve(ROOT, "circuits", "vk.json"),
  },
};

const seen = new SeenSet(CFG.seenFile);
const startedAt = Date.now();

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try {
    mkdirSync(dirname(CFG.logFile), { recursive: true });
    appendFileSync(CFG.logFile, line + "\n", "utf8");
  } catch { /* logging must never crash a task */ }
  console.log(line);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        rejectBody(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function sendJson(res, status, obj, secret) {
  const raw = JSON.stringify(obj);
  // CORS: the dashboard's browser-side preflight fetch runs from the
  // agentgames.zkverify.io origin; without this header the browser
  // blocks the response and the dashboard reports "FAILED (client)"
  // even though the server answered in ~1ms. All sensitive paths are
  // HMAC-gated, so an open origin is safe here.
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (secret) headers["x-agent-games-signature"] = signBody(secret, raw);
  res.writeHead(status, headers);
  res.end(raw);
}

async function handlePreflight(req, res) {
  // Handshake: always respond (signed). The signed body proves we hold
  // the secret; rejecting an unsigned preflight would break registration.
  await readBody(req).catch(() => null);
  sendJson(res, 200, { ok: true, protocolVersion: "v1" }, CFG.hmacSecret || null);
}

async function handleTask(req, res) {
  const t0 = Date.now();
  let taskId = "?";
  let decision = "REJECT";
  let reason = REASON.INVALID;
  let proofStatus = "skipped";
  let kurierStatus = "skipped";
  let proofTx = null;

  try {
    const raw = await readBody(req);

    // 0. PREFLIGHT (unsigned handshake): the platform calls the
    // registered endpoint URL directly with an unsigned request to
    // verify the agent is alive and holds the HMAC secret. Accept it
    // (signed response) when it is clearly not a task: no signature
    // header AND the body is empty or not a task envelope. A real
    // task is always signed, so an unsigned task envelope is still
    // rejected by the HMAC check below.
    const sigHeader = req.headers["x-agent-games-signature"];
    let env0 = null;
    let parseOk0 = false;
    try { env0 = JSON.parse(raw.toString("utf8")); parseOk0 = true; } catch { parseOk0 = false; }
    const isTaskEnvelope0 = parseOk0 && env0 && typeof env0 === "object"
      && env0.type === "agent-games.proof-gatekeeper.v1"
      && env0.input && typeof env0.input === "object";
    if (!sigHeader && !isTaskEnvelope0) {
      log({ route: "task", task_id: "preflight", ms: Date.now() - t0 });
      return sendJson(res, 200, { ok: true, protocolVersion: "v1" }, CFG.hmacSecret || null);
    }

    // 1. HMAC BEFORE parsing (fail closed when a secret is configured).
    if (CFG.hmacSecret) {
      const v = verifySignature(CFG.hmacSecret, raw, sigHeader);
      if (!v.ok) {
        log({ route: "task", task_id: taskId, error: "hmac-" + v.reason, ms: Date.now() - t0 });
        return sendJson(res, 401, { error: "invalid-signature" }, CFG.hmacSecret);
      }
    }

    // 2. Parse envelope (reuse the parse from step 0 when available).
    let env = env0;
    if (!parseOk0) {
      try {
        env = JSON.parse(raw.toString("utf8"));
      } catch {
        log({ route: "task", error: "bad-json", ms: Date.now() - t0 });
        return sendJson(res, 400, { error: "bad-json" }, CFG.hmacSecret || null);
      }
    }
    taskId = typeof env?.task_id === "string" ? env.task_id : "?";
    // A SIGNED request that is not a task envelope is the platform's
    // preflight handshake (observed: signed, type != task type ->
    // "wrong-type"). Answer it the same way as the unsigned one.
    if (env?.type && env.type !== "agent-games.proof-gatekeeper.v1") {
      log({ route: "task", task_id: "preflight", ms: Date.now() - t0 });
      return sendJson(res, 200, { ok: true, protocolVersion: "v1" }, CFG.hmacSecret || null);
    }
    const input = env?.input;
    if (!input || typeof input !== "object") {
      log({ route: "task", task_id: "preflight", ms: Date.now() - t0 });
      return sendJson(res, 200, { ok: true, protocolVersion: "v1" }, CFG.hmacSecret || null);
    }
    proofTx = typeof input.proof_tx === "string" ? input.proof_tx : null;

    // 3. Decide (7 checks).
    const d = decide({ ...input, task_id: taskId }, seen);
    decision = d.decision;
    reason = d.reason_code;

    // 4. APPROVE -> record proof_tx so a replay is caught as PROOF_REUSED.
    if (decision === "APPROVE" && proofTx) seen.add(proofTx);

    // 5. Groth16 proof (skip for PROOF_REUSED — no proof exists for a
    //    reused reference; the platform excludes those from the bonus).
    let proof = null;
    let publicSignals = null;
    if (reason !== REASON.REUSED) {
      try {
        const circuitInputs = buildCircuitInputs({ ...input, task_id: taskId }, decision, CFG.salt);
        const r = await generateProofTimed(circuitInputs, CFG.circuit, CFG.proofTimeoutMs);
        proof = r.proof;
        publicSignals = r.publicSignals;
        proofStatus = "ok";
      } catch (e) {
        proofStatus = "failed:" + String(e?.message || e).slice(0, 80);
      }
    } else {
      proofStatus = "excluded-reused";
    }

    // 6. Kurier submission (FIRE-AND-FORGET — never block the response).
    //    The platform scores the decision + local proof; the on-chain
    //    submission is a bonus. Awaiting submit+poll cost ~20s and blew
    //    the platform's tighter practice deadline (observed 24s responses
    //    on 15 Nov, practice dispatch timed out twice). Kick it off in
    //    the background and answer now; the outcome is logged when done.
    if (proof && CFG.kurierKey) {
      submitProof(CFG.kurierKey, proof, publicSignals, GATEKEEPER_VK_HASH, CFG.kurierNetwork)
        .then(async (sub) => {
          if (sub?.jobId) {
            const poll = await pollUntilFinalized(CFG.kurierKey, sub.jobId, {
              timeoutMs: CFG.kurierPollTimeoutMs,
              network: CFG.kurierNetwork,
            });
            kurierStatus = poll.finalized ? "Finalized" : `not-finalized(${poll.status})`;
          } else {
            kurierStatus = "submit-no-jobid";
          }
          log({ route: "task", task_id: taskId, decision, reason_code: reason, proof: proofStatus, kurier: kurierStatus, ms: Date.now() - t0 });
        })
        .catch((e) => {
          kurierStatus = "error:" + String(e?.message || e).slice(0, 80);
          log({ route: "task", task_id: taskId, decision, reason_code: reason, proof: proofStatus, kurier: kurierStatus, ms: Date.now() - t0 });
        });
    }

    const body = { decision, reason_code: reason, proof_tx: proofTx };
    if (proof) { body.proof = proof; body.public_signals = publicSignals; }
    log({ route: "task", task_id: taskId, decision, reason_code: reason, proof: proofStatus, kurier: kurierStatus, ms: Date.now() - t0 });
    return sendJson(res, 200, body, CFG.hmacSecret || null);
  } catch (e) {
    // Last-resort fail closed: still answer, never hang past the deadline.
    log({ route: "task", task_id: taskId, error: "handler-" + String(e?.message || e).slice(0, 120), ms: Date.now() - t0 });
    try {
      return sendJson(res, 200, { decision: "REJECT", reason_code: REASON.INVALID, proof_tx: proofTx }, CFG.hmacSecret || null);
    } catch { /* socket already gone */ }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // CORS preflight (browser OPTIONS): answer so the dashboard's
  // client-side preflight can read the response.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-agent-games-signature",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true, protocolVersion: "v1", service: "proof-gatekeeper",
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      seen_count: seen.size,
      hmac: CFG.hmacSecret ? "configured" : "missing",
      kurier: CFG.kurierKey ? "configured" : "missing",
    });
  }
  if (req.method === "GET" && path === "/") {
    return sendJson(res, 200, {
      service: "proof-gatekeeper", protocolVersion: "v1",
      endpoints: ["GET /health", "POST /preflight", "POST /task", "POST /agent"],
    });
  }
  if (req.method === "POST" && path === "/preflight") return handlePreflight(req, res);
  if (req.method === "POST" && (path === "/task" || path === "/agent")) return handleTask(req, res);

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not-found" }));
});

server.listen(CFG.port, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), event: "listening", port: CFG.port,
    hmac: CFG.hmacSecret ? "configured" : "MISSING (HMAC verification disabled)",
    kurier: CFG.kurierKey ? "configured" : "MISSING (Kurier submission disabled)",
    salt: CFG.salt, seen_count: seen.size,
  }));
  if (!CFG.hmacSecret) console.log("WARNING: AGENT_GAMES_HMAC_SECRET not set — HMAC verification is OFF. Set it in .env before registering.");
  if (!CFG.kurierKey) console.log("NOTE: KURIER_API_KEY not set — proofs are generated locally but NOT submitted to Kurier. Set it in .env when Arch provides it.");
  warmupProver();
});
