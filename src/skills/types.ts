import type { PlanStep } from "../core/types/step.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

export type Skill = {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  steps: readonly PlanStep[];
  defaultCriteria: readonly SuccessCriterion[];
  metadata: {
    keywords: readonly string[];
    domainHints: readonly string[];
    executionHints: readonly string[];
  };
};

export type SkillMatch = {
  skill: Skill;
  score: number;
  matchedKeywords: readonly string[];
};
