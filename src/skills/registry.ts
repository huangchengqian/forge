import type { Skill, SkillMatch } from "./types.ts";

export type MatchOptions = {
  query: string;
  maxResults: number;
  minScore: number;
};

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (this.skills.has(skill.id)) {
      throw new Error(`forge: skill already registered: ${skill.id}`);
    }
    this.skills.set(skill.id, skill);
  }

  get(id: string): Skill | null {
    return this.skills.get(id) ?? null;
  }

  list(): readonly Skill[] {
    return Array.from(this.skills.values());
  }

  match(opts: MatchOptions): readonly SkillMatch[] {
    const queryTokens = tokenize(opts.query);
    if (queryTokens.size === 0) return [];

    const results: SkillMatch[] = [];
    for (const skill of this.skills.values()) {
      const kwSet = new Set(skill.metadata.keywords.map((k) => k.toLowerCase()));
      const matched: string[] = [];
      for (const q of queryTokens) {
        if (kwSet.has(q)) matched.push(q);
      }
      if (matched.length === 0) continue;
      const score = scoreMatch(skill, matched, queryTokens);
      if (score < opts.minScore) continue;
      results.push({ skill, score, matchedKeywords: matched });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, opts.maxResults);
  }
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    const t = raw.trim();
    if (t.length >= 2) out.add(t);
  }
  return out;
}

function scoreMatch(skill: Skill, matched: readonly string[], queryTokens: ReadonlySet<string>): number {
  const base = matched.length;
  const catBoost = skill.category === "language" ? 0.4 : skill.category === "workflow" ? 0.3 : 0.1;
  const hintBoost = skill.metadata.executionHints.length > 0 ? 0.2 : 0;
  const kwCountBoost = skill.metadata.keywords.length > 0
    ? Math.min(skill.metadata.keywords.length, 8) * 0.05
    : 0;
  const idInQuery = queryTokens.has(skill.id.toLowerCase()) ? 0.5 : 0;
  return base + catBoost + hintBoost + kwCountBoost + idInQuery;
}
