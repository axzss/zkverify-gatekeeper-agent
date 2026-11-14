# zkVerify Agent Games — Proof Gatekeeper agent

HTTPS endpoint that receives signed Proof Gatekeeper tasks, decides
APPROVE/REJECT with the 7 documented checks, generates a local Groth16
proof (snarkjs, platform circuit), submits it to Kurier, and returns a
signed decision — all within the 60-second deadline.

## Status

- Decision logic: 7/7 trap varieties pass locally (see `npm test`).
- Proof generation: Groth16 via platform `gatekeeper.wasm` + `.zkey`,
  verified locally against the platform vk. ~0.5–2s per proof.
- Circuit inputs (13, probed from the WASM): `registeredVkHash`,
  `proofVkHash`, `minimum`, `publicBalance`, `expiryBlock`,
  `currentBlock`, `recipient`, `conditionRecipient`, `amount`,
  `maxTransfer`, `decision`, `taskId`, `salt`.
  `salt` is a private input that feeds the public commitment (signal 0);
  default `0` (env `GATEKEEPER_SALT`).
- Kurier: mainnet `https://api.kurier.xyz/api/v1`, vk already registered
  (`0x6b79c6…ad77b0`). Needs `KURIER_API_KEY` to submit.
- HMAC: `x-agent-games-signature` verified on inbound raw body, signed
  on outbound. Needs `AGENT_GAMES_HMAC_SECRET` from the dashboard.

## Run locally

```sh
cp .env.example .env   # fill in secrets
npm install
npm start              # :3000
npm test               # 7 trap tests + health/preflight (spawns :3456)
```

## Deploy (Render free tier, no card)

1. Push this repo to GitHub.
2. In Render: New → Web Service → connect the repo (or use this
   `render.yaml` Blueprint).
3. Set env vars `AGENT_GAMES_HMAC_SECRET` and `KURIER_API_KEY`.
4. Health check: `GET /health` → `{ ok: true, ... }`.

## Endpoints

- `GET /health` — liveness + config status.
- `POST /preflight` — `{ ok: true, protocolVersion: "v1" }` (signed).
- `POST /task` (alias `POST /agent`) — signed task envelope in, signed
  `{ decision, reason_code, proof_tx, proof?, public_signals? }` out.

## Files

- `src/decide.mjs` — pure 7-check decision logic.
- `src/prove.mjs` — circuit input encoding + snarkjs proof generation.
- `src/kurier.mjs` — Kurier REST client (register-vk / submit-proof /
  job-status, poll until Finalized).
- `src/seen.mjs` — persistent seen-set (JSON file) for PROOF_REUSED.
- `src/sign.mjs` — HMAC-SHA256 verify/sign.
- `src/server.mjs` — HTTP server, 60s budget, fail closed.
- `src/test.mjs` — 7-trap local harness.
- `circuits/` — platform artifacts (`gatekeeper.wasm`,
  `gatekeeper_final.zkey`, `vk.json`).

## Open questions (need dashboard / practice feedback)

- Canonical encoding of `taskId` (currently SHA3-256 of the string mod p)
  and of the vk hashes (currently BigInt(hex) mod p) — the platform's
  exact recomputation is not published. If practice shows a mismatch,
  fix `src/prove.mjs` (`fieldFromTaskId` / `fieldFromHex`).
- `salt` value, if the platform expects a specific one (default `0`).
- Kurier API key + HMAC secret (from Arch / dashboard).
