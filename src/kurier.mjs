// kurier.mjs — Kurier REST client (zkVerify mainnet verification path).
// Docs: https://docs.zkverify.io/overview/getting-started/kurier
// Base: https://api.kurier.xyz/api/v1  (mainnet)
//   POST /register-vk/:API_KEY   { proofType, proofOptions, vk } -> { vkHash }
//   POST /submit-proof/:API_KEY  { proofType, vkRegistered, proofOptions,
//                                  proofData: { proof, publicSignals, vk } }
//                                -> { jobId, optimisticVerify }
//   GET  /job-status/:API_KEY/:jobId -> { status, txHash, blockHash, ... }
// Statuses: Queued -> Valid -> Submitted -> IncludedInBlock -> Finalized
// (or Failed). The gatekeeper vk is ALREADY registered on zkVerify mainnet
// (vkHash from the platform /api/circuit-info), so submit uses
// vkRegistered: true with that hash — no re-registration needed.
// Uses Node's built-in fetch. No API key -> all functions no-op safely
// (the server still returns the locally-generated proof).

const MAINNET = "https://api.kurier.xyz/api/v1";
const TESTNET = "https://api-testnet.kurier.xyz/api/v1";

export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

export function kurierBase(network = "mainnet") {
  return network === "testnet" ? TESTNET : MAINNET;
}

async function postJson(url, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(`kurier POST failed: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(`kurier GET failed: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// One-time vk registration. Returns the registration response ({ vkHash }).
export async function registerVk(apiKey, vkJson, network = "mainnet") {
  const body = {
    proofType: "groth16",
    proofOptions: { library: "snarkjs", curve: "bn128" },
    vk: vkJson,
  };
  return postJson(`${kurierBase(network)}/register-vk/${apiKey}`, body);
}

// Submit a proof. Returns { jobId, optimisticVerify, ... }.
export async function submitProof(apiKey, proof, publicSignals, vkHash, network = "mainnet") {
  const body = {
    proofType: "groth16",
    vkRegistered: true,
    proofOptions: { library: "snarkjs", curve: "bn128" },
    proofData: { proof, publicSignals, vk: vkHash },
  };
  return postJson(`${kurierBase(network)}/submit-proof/${apiKey}`, body);
}

// Single job-status fetch. Returns the status object.
export async function jobStatus(apiKey, jobId, network = "mainnet") {
  return getJson(`${kurierBase(network)}/job-status/${apiKey}/${jobId}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until Finalized/Failed or the deadline passes.
// Returns { status, last, finalized: boolean, timedOut: boolean }.
export async function pollUntilFinalized(apiKey, jobId, { timeoutMs = 20000, intervalMs = 5000, network = "mainnet" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jobStatus(apiKey, jobId, network);
    const s = last?.status;
    if (s === "Finalized") return { status: s, last, finalized: true, timedOut: false };
    if (s === "Failed") return { status: s, last, finalized: false, timedOut: false };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return { status: last?.status ?? "unknown", last, finalized: false, timedOut: true };
}
