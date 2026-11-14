// seen.mjs — Persistent seen-set for PROOF_REUSED detection.
// Stores proof_tx values that were previously ACCEPTED (APPROVE).
// Backed by a JSON file on disk, written atomically (tmp + rename),
// so a server restart keeps the set. Only APPROVE decisions add entries.
// A proof that was REJECTED (any trap) is NOT recorded — it was never
// accepted, so it must not poison a future legitimate task.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export class SeenSet {
  constructor(filePath) {
    this.file = resolve(filePath);
    this.set = new Set();
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const arr = Array.isArray(raw) ? raw : raw.seen || [];
      for (const v of arr) if (typeof v === "string") this.set.add(v);
    } catch {
      // Corrupt file -> start empty (fail open on storage, the decision
      // logic itself still fails closed). The file is rewritten on next add.
      this.set = new Set();
    }
  }

  has(v) { return this.set.has(v); }
  get size() { return this.set.size; }

  add(v) {
    if (typeof v !== "string" || v === "") return false;
    if (this.set.has(v)) return false;
    this.set.add(v);
    this.save();
    return true;
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify({ seen: [...this.set] }, null, 0), "utf8");
      renameSync(tmp, this.file);
    } catch {
      // Best-effort persistence; a failed write must not crash a task.
    }
  }
}
