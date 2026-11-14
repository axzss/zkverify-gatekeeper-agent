# zkVerify Agent Games — Proof Gatekeeper agent — STATUS

**Agent P — 14 Nov 2026 ~20:40 WIB. Repo: https://github.com/axzss/zkverify-gatekeeper-agent (commit 79e652b, 16 files).**

## What is DONE

- **Endpoint built** — Node 22 stdlib only, `~/workspace/zkverify-agent-games/gatekeeper/`.
  `src/server.mjs` (POST /task + /agent, GET /health, POST /preflight),
  `src/decide.mjs` (7 checks), `src/prove.mjs` (snarkjs), `src/kurier.mjs`,
  `src/seen.mjs` (persistent JSON seen-set), `src/sign.mjs` (HMAC).
- **7/7 trap tests PASS** (run twice, latest 14 Nov ~20:40 WIB, `npm test`,
  9 passed / 0 failed incl. health + preflight):
  VALID_CONDITION→APPROVE/VALID_CONDITION (proof, signed, ~2.2s),
  VK_SUBSTITUTION→REJECT, THRESHOLD_MISMATCH→REJECT,
  RECIPIENT_MISMATCH→REJECT, AMOUNT_OVERFLOW→REJECT,
  EXPIRED_CONDITION→REJECT (all with a valid Groth16 proof, signed,
  0.4–0.8s), PROOF_REUSED→REJECT (no proof, correct, 4ms).
- **Proof generation VERIFIED end-to-end**: platform circuit artifacts
  downloaded (`circuits/gatekeeper.wasm` 1.755.820 B, `gatekeeper_final.zkey`
  309.750 B, `vk.json` nPublic 13). `snarkjs.groth16.fullProve` ~0.5–2s,
  local `groth16.verify` against the platform vk = **true**.
- **Circuit oracle confirmed** (probe-circuit2): decision is CONSTRAINED by
  the circuit — a wrong decision (e.g. APPROVE on a trap, REJECT on a
  valid condition) fails the witness assert at `GatekeeperEvaluation`
  line 102. So a proof can only be generated for the CORRECT decision.
  13 inputs probed: registeredVkHash, proofVkHash, minimum,
  publicBalance, expiryBlock, currentBlock, recipient,
  conditionRecipient, amount, maxTransfer, decision, taskId, salt.
  `salt` is a PRIVATE input feeding public signal 0 (a commitment);
  changing salt changes the commitment, changing trap fields does not.
  Public signals order: [commitment, registeredVkHash, proofVkHash,
  minimum, publicBalance, expiryBlock, currentBlock, recipient,
  conditionRecipient, amount, maxTransfer, decision, taskId].
- **Kurier client built** — mainnet `https://api.kurier.xyz/api/v1`,
  `submit-proof` + `job-status` + poll until Finalized. Gatekeeper vk
  already registered on mainnet (`0x6b79c6…ad77b0`) → `vkRegistered: true`,
  no re-registration needed. Needs `KURIER_API_KEY` to actually submit.
- **Pushed to GitHub** — `axzss/zkverify-gatekeeper-agent`, public,
  commit 79e652b. Includes `render.yaml` (Render Blueprint, free tier,
  healthCheckPath /health) + `README.md` + `.env.example`.
- **Prover warmup** — server generates a dummy proof at boot so the
  first real task is fast (first fullProve is the slowest).

## What is DONE — 14 Nov ~21:41 WIB (Arch, after Agent P)

- **GitHub LINKED** — Settings → Accounts → GitHub ✓ Connected as **axzss**.
- **Agent REGISTERED** — **EAGER-KESTREL-40**, event **Proof Gatekeeper only**,
  repo `github.com/axzss/zkverify-gatekeeper-agent`. HMAC secret (one-time
  dialog) saved by Arch to the protected box file
  `/home/user/.zkverify/hmac-secret.txt` (0600) — never printed.
- **Render FREE deploy LIVE** — service `srv-dbs6s1u7bikc73ep05v0`,
  public URL **https://zkverify-gatekeeper-agent.onrender.com**,
  deploy `dep-dbs6s2e7bikc73ep06og` (commit 2f3096e). Env vars set:
  AGENT_GAMES_HMAC_SECRET, KURIER_NETWORK=mainnet, GATEKEEPER_SALT=0,
  NODE_ENV=production. **KURIER_API_KEY intentionally NOT set yet**
  (no key exists — kurier.xyz signup still pending).
- **✅ ENDPOINT SAVED** (14 Nov ~21:41 WIB) —
  `https://zkverify-gatekeeper-agent.onrender.com/agent`.
  Agent list: **1 REGISTERED, 1 HEALTHY, 0 NEEDS ATTENTION**;
  card shows **EAGER-KESTREL-40 — ACTIVE — PROOF GATEKEEPER**.
- **✅ PLATFORM PREFLIGHT PASSED** — dashboard "Test preflight":
  **"Preflight OK — Healthy · 252ms"**.
- **✅ PRACTICE TASK VERIFIED** (14 Nov ~21:42 WIB, Practice Mode):
  task `practice_fea9cb3d-93d5-4b61-baea-b563e3e2a326`,
  trap **RECIPIENT_MISMATCH** → submitted **REJECT** (expected REJECT ✓),
  reason code **RECIPIENT_MISMATCH** ✓, latency **3110 ms**,
  proof **VERIFIED** ✓. This confirms the full loop end-to-end AND
  resolves the open questions: **taskId / vk-hash / salt encodings are
  CORRECT** (the platform verified the Groth16 proof, which it could
  only do if the circuit inputs matched its expectations).
- **Preflight-handshake fix (commits b1c819a + bda5a74, live on Render):**
  the platform calls the registered endpoint URL directly for its
  preflight. It is **SIGNED but carries a non-task type** — the first
  version rejected it 401 (unsigned path) and then 400 "wrong-type",
  so "Save changes" never completed (observed in Render logs).
  Now /task and /agent answer ANY non-task request (unsigned empty,
  signed wrong-type, signed minimal) with signed
  `{ok:true, protocolVersion:"v1"}`. Real tasks are still decided
  normally; unsigned task envelopes are still rejected 401
  (fail-closed). Verified locally (5 cases) + live.

## What is NOT done — needs Arch (browser / dashboard)

1. **DEPLOY (browser task, ~2 min, free, no card):**
   Render → New → Web Service → connect repo
   `axzss/zkverify-gatekeeper-agent` (or use the `render.yaml`
   Blueprint) → plan **free** → build `npm install` → start
   `node src/server.mjs` → health check path `/health`.
   Set env vars in the Render dashboard (see §2). Note the public URL.
   Fly.io needs a credit card → DO NOT use.
2. **CREDENTIALS (from the zkVerify dashboard / Arch):**
   - `AGENT_GAMES_HMAC_SECRET` (dashboard "Rotate Secret") → Render env var.
   - `KURIER_API_KEY` (kurier.xyz dashboard) → Render env var.
   - Without the HMAC secret the endpoint runs with verification OFF
     (it logs a warning); without the Kurier key, proofs are generated
     locally and returned in the response but NOT submitted to Kurier.
     Both are safe to add later — set them in Render and redeploy.
3. **KEEP-ALIVE (after deploy):** Render free spins down after 15 min
   idle — that would also reset the in-memory + on-disk seen-set
   (ephemeral disk). Once the public URL exists, tell P the URL and
   P will set up a cron that curls `/health` every ~10 min to keep it
   warm, then verify the public health check from outside.
4. **REGISTER + PREFLIGHT (Arch):** register the endpoint URL on
   https://agentgames.zkverify.io, pass the signed preflight, run a
   practice task. Target: before Round 03 (15 Nov 17:30 WIB).

## Open questions (confirm via practice-task feedback)

- Canonical encoding of `taskId` (currently SHA3-256 of the string,
  mod BN128 prime) and of the vk hashes (currently BigInt(hex) mod p).
  The platform's exact recomputation is not published. If practice
  shows a mismatch, fix `src/prove.mjs` (`fieldFromTaskId` /
  `fieldFromHex`). Single place to fix.
- `salt` value, if the platform expects a specific one (default `0`,
  env `GATEKEEPER_SALT`). The circuit accepts any salt; a proof is
  valid regardless. Only matters if the platform recomputes the
  commitment (signal 0) with a specific salt.

## Risks (documented)

- Render free: ephemeral disk → seen-set resets on a service restart.
  Keep-alive cron mitigates (restarts become rare). A reset could let
  a PROOF_REUSED trap slip through as an incorrect APPROVE (−6).
- First proof after a cold start is the slowest; warmup at boot covers it.
- The 60s deadline is comfortable: worst observed task latency ~2.2s
  (proof) + Kurier poll (bounded ~20s, best-effort — the response is
  still sent with the local proof if Kurier is slow).
