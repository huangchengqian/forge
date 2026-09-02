import type { MemoryItem, MemoryType } from "./types.ts";
import { listMemory } from "./store.ts";

export type RetrieveOptions = {
  query: string;
  types: readonly MemoryType[] | undefined;
  maxResults: number;
  minConfidence: number;
};

export type RetrievedMemory = {
  item: MemoryItem;
  score: number;
  matchedKeywords: readonly string[];
};

export async function retrieve(opts: RetrieveOptions): Promise<readonly RetrievedMemory[]> {
  const all = await listMemory();
  const queryTokens = tokenize(opts.query);
  if (queryTokens.size === 0) return [];

  const allowed = opts.types && opts.types.length > 0 ? new Set<MemoryType>(opts.types) : null;

  const results: RetrievedMemory[] = [];
  for (const item of all) {
    if (allowed && !allowed.has(item.type)) continue;
    if (item.confidence < opts.minConfidence) continue;

    const matched: string[] = [];
    for (const kw of item.keywords) {
      if (queryTokens.has(kw)) matched.push(kw);
    }
    if (matched.length === 0) continue;

    const score = scoreItem(item, matched, queryTokens);
    results.push({ item, score, matchedKeywords: matched });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, opts.maxResults);
}

function scoreItem(item: MemoryItem, matched: readonly string[], queryTokens: ReadonlySet<string>): number {
  const base = matched.length;
  const typeBoost = item.type === "PROJECT_FACT" ? 0.3 : item.type === "FAILURE_PATTERN" ? 0.2 : 0.1;
  const confidenceBoost = item.confidence * 0.5;
  const contentHit = queryTokens.has(tokenizeOne(item.content)) ? 0.4 : 0;
  return base + typeBoost + confidenceBoost + contentHit;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    const t = raw.trim();
    if (t.length >= 2) out.add(t);
  }
  return out;
}

function tokenizeOne(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "").trim();
}
