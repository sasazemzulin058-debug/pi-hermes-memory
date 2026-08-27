/**
 * Scored Memory Index — future enhancement ported from pi-self-learning.
 *
 * Adds frequency + recency scoring to core memory entries.
 * Not yet integrated into the hot path — safe to enable later.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ScoredEntry {
  key: string;      // normalised text for dedup
  text: string;       // original text
  hits: number;       // how many times referenced / saved
  score: number;      // composite score (hits - age penalty)
  firstSeen: string;  // ISO date
  lastSeen: string;   // ISO date
}

export interface ScoredIndex {
  version: 1;
  updatedAt: string;
  items: ScoredEntry[];
}

const INDEX_FILE = "scored-index.json";

function indexPath(memDir: string): string {
  return path.join(memDir, INDEX_FILE);
}

export function loadScoredIndex(memDir: string): ScoredIndex {
  const p = indexPath(memDir);
  if (!fs.existsSync(p)) {
    return { version: 1, updatedAt: new Date().toISOString(), items: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
      return {
        version: 1,
        updatedAt: String(raw.updatedAt || new Date().toISOString()),
        items: (raw.items as unknown[])
          .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
          .map((it) => ({
          key: String(it.key || ""),
          text: String(it.text || ""),
          hits: Number(it.hits) || 1,
          score: Number(it.score) || 1,
          firstSeen: String(it.firstSeen || new Date().toISOString()),
          lastSeen: String(it.lastSeen || new Date().toISOString()),
        }))
          .filter((it) => it.key && it.text),
      };
    }
  } catch { /* ignore */ }
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

export function saveScoredIndex(memDir: string, index: ScoredIndex): void {
  const p = indexPath(memDir);
  fs.writeFileSync(p, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

/** Merge a new entry into the scored index (idempotent by key). */
export function mergeEntry(
  memDir: string,
  text: string,
  now = new Date().toISOString(),
): void {
  const index = loadScoredIndex(memDir);
  const key = text.toLowerCase().replace(/\s+/g, " ");
  const existing = index.items.find((i) => i.key === key);

  if (existing) {
    existing.hits += 1;
    existing.lastSeen = now;
    // Score: hits bonus + light recency decay
    const ageDays = (Date.parse(now) - Date.parse(existing.firstSeen)) / (1000 * 60 * 60 * 24);
    existing.score = existing.hits - ageDays * 0.05;
  } else {
    index.items.push({
      key,
      text,
      hits: 1,
      score: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }

  // Keep top 100 by score
  index.items.sort((a, b) => b.score - a.score || b.hits - a.hits);
  index.items = index.items.slice(0, 100);
  index.updatedAt = now;
  saveScoredIndex(memDir, index);
}

/** Return top-ranked entries for optional injection (future: call from memory-manager). */
export function selectTopEntries(memDir: string, limit = 20): ScoredEntry[] {
  const index = loadScoredIndex(memDir);
  return index.items.slice(0, Math.max(1, limit));
}
