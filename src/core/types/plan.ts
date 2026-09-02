import type { PlanStep } from "./step.ts";

export type Plan = {
  id: string;
  version: number;
  objective: string;
  steps: readonly PlanStep[];
  createdAt: number;
  updatedAt: number;
};
