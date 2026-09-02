import type { Plan } from "../core/types/plan.ts";
import type { Observation } from "../core/types/step.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { SkillMatch } from "../skills/types.ts";

export type TaskContext = {
  task: TaskSession;
  directory: string;
  matchedSkills: readonly SkillMatch[];
};

export type UsedMemory = {
  id: string;
  type: string;
  content: string;
  confidence: number;
};

export type CreatePlanResult = {
  plan: Plan;
  source: "llm" | "fallback" | "skill";
  appliedSkills: readonly string[];
  /** Memories retrieved and injected into the planner prompt (UI transparency). */
  usedMemories?: readonly UsedMemory[];
};

export type UpdatePlanResult = {
  plan: Plan;
  changed: boolean;
} | null;

export interface Planner {
  createPlan(ctx: TaskContext): Promise<CreatePlanResult>;
  updatePlan(ctx: TaskContext, observation: Observation): Promise<UpdatePlanResult>;
}
