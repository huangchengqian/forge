import type { TaskState } from "../core/state/task-state.ts";
import type { MemoryItem, RetrievedMemory } from "../memory/index.ts";
import type { Plan } from "../core/types/plan.ts";
import type { PlanOperation } from "../orchestrator/plan-ops.ts";
import type { EvaluationResult } from "../core/types/evaluation.ts";

export type ForgeEvent =
  | { type: "task_started"; taskId: string; goal: string; at: number }
  | {
      type: "state_changed";
      taskId: string;
      from: TaskState;
      to: TaskState;
      at: number;
    }
  | { type: "step_started"; taskId: string; stepId: string; at: number }
  | { type: "step_verified"; taskId: string; stepId: string; at: number }
  | {
      type: "fix_started";
      taskId: string;
      stepId: string;
      attempt: number;
      reason: string;
      at: number;
    }
  | {
      type: "memory_retrieved";
      taskId: string;
      query: string;
      results: readonly RetrievedMemory[];
      at: number;
    }
  | {
      type: "memory_extracted";
      taskId: string;
      items: readonly MemoryItem[];
      at: number;
    }
  | {
      type: "plan_created";
      taskId: string;
      plan: Plan;
      source: "llm" | "fallback" | "skill";
      at: number;
    }
  | {
      type: "plan_revised";
      taskId: string;
      plan: Plan;
      ops: readonly PlanOperation[];
      at: number;
    }
  | {
      type: "evaluation_started";
      taskId: string;
      at: number;
    }
  | {
      type: "evaluation_completed";
      taskId: string;
      result: EvaluationResult;
      at: number;
    }
  | {
      type: "completed";
      taskId: string;
      at: number;
    }
  | { type: "failed"; taskId: string; reason: string; at: number }
  | {
      type: "pi_event";
      taskId: string;
      sessionId: string;
      payload: unknown;
      at: number;
    };

export type EventListener = (event: ForgeEvent) => void;
